import { describe, expect, it } from 'vitest';
import {
  attachmentFileName,
  DEFAULT_FOLDER_NAME,
  dateStamp,
  fileNameOf,
  filesFolderName,
  folderSegments,
  itemAttachmentPath,
  itemFilePath,
  itemStem,
  MAX_PATH_UNITS,
  MAX_SEGMENT_UNITS,
  sanitizeFileName,
  uniqueZipPath,
  zipAttachmentPath,
  zipEntryPath,
  zipFileName,
  zipFilePath,
} from '../../../src/lib/export/filename';
import type { FileNameOptions } from '../../../src/lib/export/filename';
import type { ExportTarget } from '../../../src/lib/export/types';

function target(overrides: Partial<ExportTarget> = {}): ExportTarget {
  return {
    channelId: '100000000000000001',
    kind: 'text',
    channelName: 'general',
    guildId: '200000000000000001',
    guildName: 'My Server',
    categoryName: 'Text Channels',
    parentChannelName: null,
    topic: null,
    ...overrides,
  };
}

/** 2026-10-06 15:30 UTC: still the 6th in UTC, already 00:30 on the 7th in Seoul. */
const DATE = new Date('2026-10-06T15:30:00Z');
const NAME_OPTIONS: FileNameOptions = { locale: 'en', dateInFileName: true, date: DATE, timeZone: 'UTC', partial: false };
const opts = (overrides: Partial<FileNameOptions> = {}): FileNameOptions => ({ ...NAME_OPTIONS, ...overrides });

const hasLoneSurrogate = (s: string): boolean => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

describe('sanitizeFileName (docs/PLAN.md §6.6, per segment)', () => {
  it('keeps ordinary names, including Korean and emoji', () => {
    expect(sanitizeFileName('general')).toBe('general');
    expect(sanitizeFileName('잡담 채널')).toBe('잡담 채널');
    expect(sanitizeFileName('모임방')).toBe('모임방');
    expect(sanitizeFileName('수학모임')).toBe('수학모임');
    expect(sanitizeFileName('party 🎉')).toBe('party 🎉');
  });

  it('replaces path separators and every Windows-forbidden character: < > : " / \\ | ? *', () => {
    expect(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j');
    expect(sanitizeFileName('../../etc/passwd')).toBe('_.._etc_passwd');
    for (const ch of '<>:"/\\|?*') expect(sanitizeFileName(`a${ch}b`)).toBe('a_b');
  });

  it('replaces "%" (it would start an escape in a download path or a URL)', () => {
    expect(sanitizeFileName('100% 완료')).toBe('100_ 완료');
    expect(sanitizeFileName('file%20name%2e')).toBe('file_20name_2e');
    expect(sanitizeFileName('%')).toBe('_');
    expect(sanitizeFileName('%41')).toBe('_41');
  });

  it('never produces a ".." path component or a separator', () => {
    for (const evil of ['..', '../..', '..\\..\\x', '/', '\\', '.', '. .', '...']) {
      const out = sanitizeFileName(evil);
      expect(out).not.toMatch(/[\\/]/);
      expect(out).not.toBe('..');
      expect(out).not.toBe('.');
    }
  });

  it('replaces control characters and turns whitespace controls into spaces', () => {
    expect(sanitizeFileName('a\u0000b\u001Fc\u007Fd\u0085e')).toBe('a_b_c_d_e');
    expect(sanitizeFileName('line1\nline2\tx\r\ny')).toBe('line1 line2 x y');
  });

  it('collapses runs of whitespace (incl. NBSP and ideographic space)', () => {
    expect(sanitizeFileName('a   b \u00A0\u3000 c')).toBe('a b c');
  });

  it('strips leading and trailing dots and spaces, including the leading dot of a hidden file', () => {
    expect(sanitizeFileName('  ..name.. ')).toBe('name');
    expect(sanitizeFileName('name. . .')).toBe('name');
    expect(sanitizeFileName('.gitignore')).toBe('gitignore');
    expect(sanitizeFileName('   ')).toBe('unnamed');
  });

  it('removes invisible and bidi-override characters that could disguise an extension', () => {
    expect(sanitizeFileName('foo\u202Etxt.exe')).toBe('footxt.exe');
    expect(sanitizeFileName('a\u200Bb\u2066c\uFEFFd')).toBe('abcd');
    for (const ch of ['\u200E', '\u200F', '\u202A', '\u202B', '\u202C', '\u202D', '\u202E', '\u2066', '\u2067', '\u2068', '\u2069', '\u061C']) {
      expect(sanitizeFileName(`a${ch}b`)).toBe('ab');
    }
  });

  it('keeps ZWJ so emoji sequences survive', () => {
    const family = '👨\u200D👩\u200D👧';
    expect(sanitizeFileName(family)).toBe(family);
  });

  describe('Windows reserved device names get a "_" in FRONT, with or without extension', () => {
    it.each([
      ['CON', '_CON'],
      ['PRN', '_PRN'],
      ['AUX', '_AUX'],
      ['NUL', '_NUL'],
      ['nul', '_nul'],
      ['Con', '_Con'],
      ['COM1', '_COM1'],
      ['Com9', '_Com9'],
      ['LPT1', '_LPT1'],
      ['LPT9', '_LPT9'],
      ['lpt5', '_lpt5'],
      ['aux.txt', '_aux.txt'],
      ['CON.anything', '_CON.anything'],
      ['con.tar.gz', '_con.tar.gz'],
      ['COM¹', '_COM¹'],
      ['LPT²', '_LPT²'],
      ['CON .log', '_CON .log'],
      ['CON  ', '_CON'],
    ])('%s -> %s', (input, expected) => {
      expect(sanitizeFileName(input)).toBe(expected);
    });

    it('covers every COM1-COM9 and LPT1-LPT9', () => {
      for (let n = 1; n <= 9; n += 1) {
        expect(sanitizeFileName(`COM${n}`)).toBe(`_COM${n}`);
        expect(sanitizeFileName(`LPT${n}.txt`)).toBe(`_LPT${n}.txt`);
      }
    });

    it('leaves names that merely start with, or contain, a reserved word alone', () => {
      expect(sanitizeFileName('console')).toBe('console');
      expect(sanitizeFileName('COM10')).toBe('COM10');
      expect(sanitizeFileName('nullable.txt')).toBe('nullable.txt');
      expect(sanitizeFileName('my CON')).toBe('my CON');
      expect(sanitizeFileName('CON-x')).toBe('CON-x');
      expect(sanitizeFileName('x.CON')).toBe('x.CON');
      expect(sanitizeFileName('prn2')).toBe('prn2');
    });

    it('re-checks after the dots and spaces around it are gone', () => {
      expect(sanitizeFileName('...CON...')).toBe('_CON');
      expect(sanitizeFileName(' nul')).toBe('_nul');
    });
  });

  it('caps a segment at 80 UTF-16 code units', () => {
    expect(sanitizeFileName('x'.repeat(200))).toHaveLength(MAX_SEGMENT_UNITS);
    expect(MAX_SEGMENT_UNITS).toBe(80);
    expect(sanitizeFileName('가'.repeat(200))).toBe('가'.repeat(80));
  });

  it('does not split surrogate pairs when capping', () => {
    // 79 ASCII + one emoji (2 units) => the pair straddles the 80-unit limit.
    const input = `${'a'.repeat(79)}😀tail`;
    const out = sanitizeFileName(input);
    expect(out).toBe('a'.repeat(79));
    expect(out.length).toBeLessThanOrEqual(80);

    const allEmoji = sanitizeFileName('😀'.repeat(60));
    expect(allEmoji).toBe('😀'.repeat(40));
    expect(hasLoneSurrogate(allEmoji)).toBe(false);
  });

  it('re-trims after capping and cannot expose a reserved name by truncation', () => {
    expect(sanitizeFileName(`${'a'.repeat(79)} .tail`)).toBe('a'.repeat(79));
    const out = sanitizeFileName(`CON${'.'.repeat(100)}x`);
    expect(out.startsWith('_CON')).toBe(true);
  });

  it('replaces lone surrogates', () => {
    expect(sanitizeFileName('a\uD800b\uDC00c')).toBe('a_b_c');
  });

  it('normalises to NFC (a decomposed Hangul syllable is the composed one)', () => {
    const decomposed = '한'; // Hangul jamo for 한
    expect(sanitizeFileName(decomposed)).toBe('한');
    expect(sanitizeFileName('e\u0301')).toBe('é');
  });

  it('uses the fallback for empty results', () => {
    expect(sanitizeFileName('')).toBe('unnamed');
    expect(sanitizeFileName('...', 'fallback')).toBe('fallback');
    expect(sanitizeFileName(' \u200B ', 'fb')).toBe('fb');
  });

  it('sanitises the fallback too and never returns an empty string', () => {
    expect(sanitizeFileName('', 'a/b')).toBe('a_b');
    expect(sanitizeFileName('', '...')).toBe('unnamed');
    expect(sanitizeFileName('', 'CON')).toBe('_CON');
  });

  it('is idempotent', () => {
    for (const name of ['a/b', 'CON', ' x. ', '😀'.repeat(60), 'a\u202Eb', '%41', '모임방 - 수학모임', 'x'.repeat(300)]) {
      const once = sanitizeFileName(name);
      expect(sanitizeFileName(once)).toBe(once);
    }
  });

  it('survives hostile input without throwing and always yields a safe segment', () => {
    const hostile = ['\u0000'.repeat(500), '\uD800'.repeat(100), '../'.repeat(100), `${'a'.repeat(5000)}\u202E`, '\u202E'.repeat(50), '.'.repeat(500), '\\\\server\\share\\x', 'C:\\Windows\\system32', '/etc/passwd'];
    for (const name of hostile) {
      const out = sanitizeFileName(name);
      expect(out.length).toBeGreaterThan(0);
      expect(out.length).toBeLessThanOrEqual(80);
      expect(out).not.toMatch(/[\\/:*?"<>|%\u0000-\u001f]/);
      expect(out).not.toMatch(/^[. ]|[. ]$/);
      expect(hasLoneSurrogate(out)).toBe(false);
    }
  });
});

describe('itemStem and the names of individual files (docs/PLAN.md §6.6)', () => {
  it('a server channel is "<server> - <channel> (YYYY-MM-DD)"', () => {
    expect(itemStem(target(), 'html', opts())).toBe('My Server - general (2026-10-06)');
  });

  it('the Korean example of the plan', () => {
    const t = target({ guildName: '모임방', channelName: '수학모임' });
    expect(itemStem(t, 'html', opts())).toBe('모임방 - 수학모임 (2026-10-06)');
    expect(itemFilePath('Discord Export', itemStem(t, 'html', opts()), 'html')).toBe('Discord Export/모임방 - 수학모임 (2026-10-06).html');
  });

  it('a DM is "DM - <name>", a group DM too', () => {
    const dm = target({ kind: 'dm', guildId: null, guildName: null, categoryName: null, channelName: 'Sampson' });
    expect(itemStem(dm, 'html', opts())).toBe('DM - Sampson (2026-10-06)');
    expect(itemFilePath('Discord Export', itemStem(dm, 'html', opts()), 'html')).toBe('Discord Export/DM - Sampson (2026-10-06).html');
    const group = target({ kind: 'group-dm', guildId: null, guildName: null, categoryName: null, channelName: '주말 보드게임 모임 🎲' });
    expect(itemStem(group, 'txt', opts())).toBe('DM - 주말 보드게임 모임 🎲 (2026-10-06)');
  });

  it('a thread is "<server> - <parent> - <thread>"', () => {
    const thread = target({ kind: 'thread', channelName: 'bug report', parentChannelName: 'support' });
    expect(itemStem(thread, 'md', opts())).toBe('My Server - support - bug report (2026-10-06)');
  });

  it('a thread without a known parent is "<server> - <thread>"', () => {
    const thread = target({ kind: 'thread', channelName: 'bug report', parentChannelName: null });
    expect(itemStem(thread, 'md', opts())).toBe('My Server - bug report (2026-10-06)');
  });

  it('the date is optional', () => {
    expect(itemStem(target(), 'html', opts({ dateInFileName: false }))).toBe('My Server - general');
  });

  it('a partial export gets " (부분)" in Korean and " (partial)" in English, after the date', () => {
    expect(itemStem(target(), 'html', opts({ partial: true, locale: 'ko' }))).toBe('My Server - general (2026-10-06) (부분)');
    expect(itemStem(target(), 'html', opts({ partial: true, locale: 'en' }))).toBe('My Server - general (2026-10-06) (partial)');
    expect(itemStem(target(), 'html', opts({ partial: true, locale: 'ko', dateInFileName: false }))).toBe('My Server - general (부분)');
    expect(itemStem(target(), 'html', opts({ partial: true, locale: 'en', dateInFileName: false }))).toBe('My Server - general (partial)');
  });

  it('an unexpected locale falls back to English', () => {
    expect(itemStem(target(), 'html', opts({ partial: true, locale: 'fr' as 'en' }))).toBe('My Server - general (2026-10-06) (partial)');
  });

  it('the date is the day in the export time zone', () => {
    expect(itemStem(target(), 'html', opts({ timeZone: 'UTC' }))).toContain('(2026-10-06)');
    expect(itemStem(target(), 'html', opts({ timeZone: 'Asia/Seoul' }))).toContain('(2026-10-07)');
    expect(itemStem(target(), 'html', opts({ timeZone: 'America/Los_Angeles' }))).toContain('(2026-10-06)');
    expect(itemStem(target(), 'html', opts({ timeZone: 'Pacific/Kiritimati', date: new Date('2026-10-06T11:00:00Z') }))).toContain('(2026-10-07)');
  });

  it("'auto' (or an empty zone) uses the machine's own zone", () => {
    const local = new Date(2026, 9, 6, 23, 30);
    expect(dateStamp(local, 'auto')).toBe('2026-10-06');
    expect(dateStamp(local, '')).toBe('2026-10-06');
    expect(itemStem(target(), 'html', opts({ date: local, timeZone: 'auto' }))).toContain('(2026-10-06)');
    const newYear = new Date(2027, 0, 1, 0, 5);
    expect(dateStamp(newYear, 'auto')).toBe('2027-01-01');
  });

  it('sanitises every part and falls back for blank names', () => {
    const t = target({ guildName: 'a/b', channelName: 'c|d' });
    expect(itemStem(t, 'json', opts({ dateInFileName: false }))).toBe('a_b - c_d');
    const blank = target({ guildName: '', channelName: '', channelId: '42' });
    expect(itemStem(blank, 'json', opts({ dateInFileName: false }))).toBe('Unknown Server - 42');
    const dmBlank = target({ kind: 'dm', guildName: null, channelName: '...', channelId: '43' });
    expect(itemStem(dmBlank, 'json', opts({ dateInFileName: false }))).toBe('DM - 43');
  });

  it('Windows reserved names only matter for the whole file name: "CON - general.txt" is no device, "nul.backup - x.txt" is', () => {
    const t = target({ guildName: 'CON', channelName: 'general' });
    expect(itemStem(t, 'txt', opts({ dateInFileName: false }))).toBe('CON - general');
    expect(fileNameOf(itemStem(t, 'txt', opts()), 'txt')).toBe('CON - general (2026-10-06).txt');
    // Windows reads everything before the first dot: "nul.backup - x.txt" is the device NUL
    const dot = target({ guildName: 'nul.backup', channelName: 'x' });
    expect(itemStem(dot, 'txt', opts({ dateInFileName: false }))).toBe('_nul.backup - x');
    // a channel called "con" sits behind the server name: no device name, and no needless underscore
    expect(itemStem(target({ channelName: 'con' }), 'txt', opts({ dateInFileName: false }))).toBe('My Server - con');
    // a DM partner called con is behind "DM - "
    expect(itemStem(target({ kind: 'dm', guildName: null, channelName: 'con' }), 'txt', opts({ dateInFileName: false }))).toBe('DM - con');
    // a server without a name falls back to "Unknown Server", never to a bare device name
    expect(itemStem(target({ guildName: 'COM1', channelName: '' , channelId: '7'}), 'txt', opts({ dateInFileName: false }))).toBe('COM1 - 7');
  });

  it('the file name as a whole is never a device name, whatever the parts are', () => {
    for (const guildName of ['CON', 'prn', 'aux', 'NUL', 'COM1', 'LPT9', 'con.x', 'nul.']) {
      for (const partial of [false, true]) {
        for (const dateInFileName of [false, true]) {
          const file = fileNameOf(itemStem(target({ guildName, channelName: 'c' }), 'txt', opts({ partial, dateInFileName })), 'txt');
          expect(file.split('.')[0]!.trimEnd()).not.toMatch(/^(?:CON|PRN|AUX|NUL|COM\d|LPT\d)$/i);
        }
      }
    }
  });

  it('keeps "<stem>.<ext>" within 80 units, cutting the name and never the date or the partial marker', () => {
    const long = target({ guildName: 'S'.repeat(60), channelName: 'c'.repeat(100) });
    for (const ext of ['html', 'xlsx', 'json']) {
      for (const partial of [false, true]) {
        const stem = itemStem(long, ext, opts({ partial, locale: 'ko' }));
        const file = fileNameOf(stem, ext);
        expect(file.length).toBeLessThanOrEqual(MAX_SEGMENT_UNITS);
        expect(stem.includes('(2026-10-06)')).toBe(true);
        expect(stem.endsWith(partial ? '(2026-10-06) (부분)' : '(2026-10-06)')).toBe(true);
      }
    }
  });

  it('cuts Korean and emoji names on character boundaries', () => {
    const t = target({ guildName: '모임방', channelName: '😀'.repeat(60) });
    const stem = itemStem(t, 'html', opts({ partial: true, locale: 'ko' }));
    expect(hasLoneSurrogate(stem)).toBe(false);
    expect(fileNameOf(stem, 'html').length).toBeLessThanOrEqual(80);
    expect(stem.startsWith('모임방 - 😀')).toBe(true);
  });

  it('a tiny name still gets its date', () => {
    expect(itemStem(target({ guildName: 'S', channelName: 'c' }), 'html', opts())).toBe('S - c (2026-10-06)');
  });

  it('normalises to NFC, so a decomposed Korean name gives the same file name', () => {
    const decomposed = target({ channelName: '한글'.normalize('NFD') });
    expect(itemStem(decomposed, 'html', opts({ dateInFileName: false }))).toBe(itemStem(target({ channelName: '한글' }), 'html', opts({ dateInFileName: false })));
  });
});

describe('fileNameOf / filesFolderName / attachmentFileName', () => {
  it('fileNameOf adds the extension and tolerates a leading dot', () => {
    expect(fileNameOf('a b', 'html')).toBe('a b.html');
    expect(fileNameOf('a b', '.xlsx')).toBe('a b.xlsx');
  });

  it('the attachment folder of a file is "<stem>_files"', () => {
    expect(filesFolderName('모임방 - 수학모임 (2026-10-06)')).toBe('모임방 - 수학모임 (2026-10-06)_files');
  });

  it('a long stem gives a folder name of at most 80 units', () => {
    const name = filesFolderName('x'.repeat(80));
    expect(name).toHaveLength(80);
    expect(name.endsWith('_files')).toBe(true);
    expect(filesFolderName(`${'y'.repeat(73)} .`)).toBe(`${'y'.repeat(73)}_files`);
    expect(filesFolderName('')).toBe('unnamed_files');
  });

  it('an attachment file is "<id>_<original name>"', () => {
    expect(attachmentFileName('123456789012345678', 'photo.png')).toBe('123456789012345678_photo.png');
    expect(attachmentFileName('1', '화면 캡처 2026-10-06.png')).toBe('1_화면 캡처 2026-10-06.png');
  });

  it('sanitises the original name, whatever it carries', () => {
    expect(attachmentFileName('1', 'a/b\\c:d.png')).toBe('1_a_b_c_d.png');
    expect(attachmentFileName('1', '../../etc/passwd')).toBe('1__.._etc_passwd');
    expect(attachmentFileName('1', 'evil\u202Etxt.exe')).toBe('1_eviltxt.exe');
    expect(attachmentFileName('1', '100%.png')).toBe('1_100_.png');
    expect(attachmentFileName('1', 'CON.png')).toBe('1_CON.png'); // the id in front: not a device name
    expect(attachmentFileName('1', '.hidden')).toBe('1_hidden');
  });

  it('an empty or unusable name becomes "file"', () => {
    expect(attachmentFileName('1', '')).toBe('1_file');
    expect(attachmentFileName('1', '...')).toBe('1_file');
    expect(attachmentFileName('', 'a.png')).toBe('file_a.png');
  });

  it('the same name with different ids gives different files', () => {
    expect(attachmentFileName('1', 'image.png')).not.toBe(attachmentFileName('2', 'image.png'));
  });

  it('a long name is cut but keeps its extension and the 80-unit limit', () => {
    const name = attachmentFileName('123456789012345678', `${'가'.repeat(200)}.jpeg`);
    expect(name).toHaveLength(80);
    expect(name.startsWith('123456789012345678_가')).toBe(true);
    expect(name.endsWith('.jpeg')).toBe(true);
    const noExt = attachmentFileName('123456789012345678', 'x'.repeat(200));
    expect(noExt).toHaveLength(80);
  });

  it('does not take a very long "extension" for one, and does not split emoji', () => {
    const odd = attachmentFileName('1', `${'a'.repeat(100)}.${'b'.repeat(50)}`);
    expect(odd.length).toBeLessThanOrEqual(80);
    const emoji = attachmentFileName('123456789012345678', `${'😀'.repeat(60)}.png`);
    expect(hasLoneSurrogate(emoji)).toBe(false);
    expect(emoji.length).toBeLessThanOrEqual(80);
    expect(emoji.endsWith('.png')).toBe(true);
  });

  it('copes with an absurd id', () => {
    expect(attachmentFileName('9'.repeat(100), 'a.png').length).toBeLessThanOrEqual(80);
  });
});

describe('folderSegments / itemFilePath', () => {
  it('the default folder', () => {
    expect(DEFAULT_FOLDER_NAME).toBe('Discord Export');
    expect(folderSegments('Discord Export')).toEqual(['Discord Export']);
    expect(itemFilePath('Discord Export', 'My Server - general (2026-10-06)', 'html')).toBe('Discord Export/My Server - general (2026-10-06).html');
  });

  it('a folder setting with several parts is several segments, each sanitised', () => {
    expect(folderSegments('Backups/Discord')).toEqual(['Backups', 'Discord']);
    expect(folderSegments('Backups\\Discord')).toEqual(['Backups', 'Discord']);
    expect(folderSegments('a:b/c*d')).toEqual(['a_b', 'c_d']);
    expect(folderSegments('디스코드 백업')).toEqual(['디스코드 백업']);
  });

  it('never lets the folder escape: traversal, absolute paths and empty parts disappear', () => {
    expect(folderSegments('../../evil')).toEqual(['evil']);
    for (const hostile of ['../../evil', '/abs/path', 'C:\\Windows', '..', '.', '//', '/', '', '   ', './x/../y']) {
      const segments = folderSegments(hostile);
      expect(segments.length).toBeGreaterThan(0);
      for (const segment of segments) {
        expect(segment).not.toMatch(/[\\/:]/);
        expect(segment).not.toBe('..');
        expect(segment).not.toBe('.');
        expect(segment).not.toBe('');
      }
    }
    expect(folderSegments('/abs/path')).toEqual(['abs', 'path']);
    expect(folderSegments('')).toEqual([DEFAULT_FOLDER_NAME]);
    expect(folderSegments('  ')).toEqual([DEFAULT_FOLDER_NAME]);
    expect(folderSegments('..')).toEqual([DEFAULT_FOLDER_NAME]);
  });

  it('reserved names in the folder get the underscore', () => {
    expect(folderSegments('CON')).toEqual(['_CON']);
    expect(itemFilePath('con/nul', 'x', 'txt')).toBe('_con/_nul/x.txt');
  });

  it('a very long folder setting is kept short so that the rest of the path keeps its budget', () => {
    const segments = folderSegments('x'.repeat(200));
    expect(segments.join('/').length).toBeLessThanOrEqual(70);
    const many = folderSegments(Array.from({ length: 20 }, (_, i) => `folder-number-${i}`).join('/'));
    expect(many.length).toBeLessThanOrEqual(4);
    expect(many.join('/').length).toBeLessThanOrEqual(70);
    expect(many[0]).toContain('folder-number-0');
    const deep = folderSegments('a/b/c/d/e/f/g');
    expect(deep).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('itemAttachmentPath: <folder>/<stem>_files/<id>_<name>', () => {
  it('the saved copy next to its file, and the path relative to that file', () => {
    const stem = '모임방 - 수학모임 (2026-10-06)';
    const { path, relative } = itemAttachmentPath('Discord Export', stem, '123456789012345678', 'photo.png');
    expect(path).toBe('Discord Export/모임방 - 수학모임 (2026-10-06)_files/123456789012345678_photo.png');
    expect(relative).toBe('모임방 - 수학모임 (2026-10-06)_files/123456789012345678_photo.png');
    expect(path.endsWith(`/${relative}`)).toBe(true);
  });

  it('the relative path is what follows the folder of the file in the full path, also when it had to be shortened', () => {
    const stem = itemStem(target({ guildName: 'S'.repeat(80), channelName: 'c'.repeat(80) }), 'html', opts({ partial: true, locale: 'ko' }));
    for (const folder of ['Discord Export', 'x'.repeat(200), 'a/b/c/d/e/f']) {
      const { path, relative } = itemAttachmentPath(folder, stem, '123456789012345678', `${'n'.repeat(150)}.png`);
      expect(path.endsWith(`/${relative}`)).toBe(true);
      expect(path.length).toBeLessThanOrEqual(MAX_PATH_UNITS);
      expect(relative.split('/')).toHaveLength(2);
      for (const segment of path.split('/')) expect(segment.length).toBeLessThanOrEqual(MAX_SEGMENT_UNITS);
      expect(relative.endsWith('.png')).toBe(true);
      expect(relative.includes('123456789012345678_')).toBe(true);
    }
  });

  it('the whole path is at most 180 units', () => {
    expect(MAX_PATH_UNITS).toBe(180);
    const { path } = itemAttachmentPath('Discord Export', 'x'.repeat(74), '123456789012345678', `${'y'.repeat(200)}.jpeg`);
    expect(path.length).toBeLessThanOrEqual(180);
  });

  it('two attachments of one file share the folder', () => {
    const a = itemAttachmentPath('Discord Export', 'stem', '1', 'a.png');
    const b = itemAttachmentPath('Discord Export', 'stem', '2', 'a.png');
    expect(a.path.split('/').slice(0, -1)).toEqual(b.path.split('/').slice(0, -1));
    expect(a.path).not.toBe(b.path);
  });
});

describe('zipFileName / zipFilePath', () => {
  it('is "Discord Export YYYY-MM-DD HHmm.zip" with the time to the minute', () => {
    expect(zipFileName(new Date(2026, 9, 6, 13, 5), { timeZone: 'auto' })).toBe('Discord Export 2026-10-06 1305.zip');
    expect(zipFileName(new Date(2026, 0, 2, 0, 0, 1))).toBe('Discord Export 2026-01-02 0000.zip');
    expect(zipFileName(new Date(2026, 11, 31, 23, 59, 59))).toBe('Discord Export 2026-12-31 2359.zip');
  });

  it('uses the export time zone', () => {
    expect(zipFileName(DATE, { timeZone: 'UTC' })).toBe('Discord Export 2026-10-06 1530.zip');
    expect(zipFileName(DATE, { timeZone: 'Asia/Seoul' })).toBe('Discord Export 2026-10-07 0030.zip');
    expect(zipFileName(new Date('2026-10-06T15:00:00Z'), { timeZone: 'Asia/Seoul' })).toBe('Discord Export 2026-10-07 0000.zip');
    expect(zipFileName(new Date('2026-10-06T14:59:00Z'), { timeZone: 'Asia/Seoul' })).toBe('Discord Export 2026-10-06 2359.zip');
    expect(zipFileName(new Date('2026-03-08T10:30:00Z'), { timeZone: 'America/New_York' })).toBe('Discord Export 2026-03-08 0630.zip');
  });

  it('midnight is 0000, never 2400', () => {
    for (const zone of ['UTC', 'Asia/Seoul', 'Europe/Berlin', 'America/Chicago']) {
      const name = zipFileName(new Date('2026-01-01T00:00:00Z'), { timeZone: zone });
      expect(name).not.toContain(' 24');
      expect(name).toMatch(/^Discord Export 20\d\d-\d\d-\d\d \d{4}\.zip$/);
    }
  });

  it('a partial ZIP carries the marker in the language of the files', () => {
    expect(zipFileName(DATE, { timeZone: 'UTC', partial: true, locale: 'ko' })).toBe('Discord Export 2026-10-06 1530 (부분).zip');
    expect(zipFileName(DATE, { timeZone: 'UTC', partial: true, locale: 'en' })).toBe('Discord Export 2026-10-06 1530 (partial).zip');
    expect(zipFileName(DATE, { timeZone: 'UTC', partial: true })).toBe('Discord Export 2026-10-06 1530 (partial).zip');
    expect(zipFileName(DATE, { timeZone: 'UTC', partial: false, locale: 'ko' })).toBe('Discord Export 2026-10-06 1530.zip');
  });

  it('an unknown time zone reads as UTC rather than failing', () => {
    expect(zipFileName(DATE, { timeZone: 'Not/AZone' })).toBe('Discord Export 2026-10-06 1530.zip');
  });

  it('is placed in the folder setting', () => {
    expect(zipFilePath('Discord Export', DATE, { timeZone: 'UTC' })).toBe('Discord Export/Discord Export 2026-10-06 1530.zip');
    expect(zipFilePath('백업/디스코드', DATE, { timeZone: 'UTC', partial: true, locale: 'ko' })).toBe('백업/디스코드/Discord Export 2026-10-06 1530 (부분).zip');
  });
});

describe('zipEntryPath', () => {
  it('builds Server/Category/channel.ext', () => {
    expect(zipEntryPath(target(), 'html', new Set())).toBe('My Server/Text Channels/general.html');
  });

  it('omits the category folder when there is none', () => {
    expect(zipEntryPath(target({ categoryName: null }), 'txt', new Set())).toBe('My Server/general.txt');
  });

  it('puts DMs and group DMs under Direct Messages', () => {
    const dm = target({ kind: 'dm', guildId: null, guildName: null, categoryName: null, channelName: 'Alice' });
    expect(zipEntryPath(dm, 'md', new Set())).toBe('Direct Messages/Alice.md');
    const group = target({ kind: 'group-dm', guildId: null, guildName: null, categoryName: null, channelName: 'A, B, C' });
    expect(zipEntryPath(group, 'md', new Set())).toBe('Direct Messages/A, B, C.md');
  });

  it('names threads "Parent - Thread"', () => {
    const thread = target({ kind: 'thread', channelName: 'bug report', parentChannelName: 'support' });
    expect(zipEntryPath(thread, 'html', new Set())).toBe('My Server/Text Channels/support - bug report.html');
  });

  it('puts the posts of a forum into a folder named after the forum', () => {
    const post = target({ kind: 'thread', channelName: '질문 있어요', parentChannelName: '질문-게시판', categoryName: '개발' });
    expect(zipEntryPath(post, 'html', new Set(), { forumPost: true })).toBe('My Server/개발/질문-게시판/질문 있어요.html');
    const noCategory = target({ kind: 'thread', channelName: 'q', parentChannelName: 'forum', categoryName: null });
    expect(zipEntryPath(noCategory, 'txt', new Set(), { forumPost: true })).toBe('My Server/forum/q.txt');
  });

  it('uses the thread name alone when the parent is unknown', () => {
    const thread = target({ kind: 'thread', channelName: 'bug report', parentChannelName: null });
    expect(zipEntryPath(thread, 'html', new Set())).toBe('My Server/Text Channels/bug report.html');
  });

  it('a partial chat is marked in its entry name', () => {
    expect(zipEntryPath(target(), 'html', new Set(), { partial: true, locale: 'ko' })).toBe('My Server/Text Channels/general (부분).html');
    expect(zipEntryPath(target(), 'html', new Set(), { partial: true, locale: 'en' })).toBe('My Server/Text Channels/general (partial).html');
  });

  it('sanitises every component, Korean names and reserved names included', () => {
    const t = target({ guildName: 'a/b', categoryName: 'c:d', channelName: 'e*f' });
    expect(zipEntryPath(t, 'csv', new Set())).toBe('a_b/c_d/e_f.csv');
    const korean = target({ guildName: '모임방', categoryName: '수학', channelName: '수학모임' });
    expect(zipEntryPath(korean, 'xlsx', new Set())).toBe('모임방/수학/수학모임.xlsx');
    const reserved = target({ guildName: 'CON', categoryName: 'AUX', channelName: 'nul' });
    expect(zipEntryPath(reserved, 'txt', new Set())).toBe('_CON/_AUX/_nul.txt');
  });

  it('falls back sensibly for blank names', () => {
    const t = target({ guildName: '', categoryName: '...', channelName: '', channelId: '42' });
    expect(zipEntryPath(t, 'json', new Set())).toBe('Unknown Server/Category/42.json');
  });

  it('tolerates a leading dot on the extension', () => {
    expect(zipEntryPath(target(), '.xlsx', new Set())).toBe('My Server/Text Channels/general.xlsx');
  });

  it('never yields a path with an empty, "." or ".." segment', () => {
    for (const evil of ['..', '.', '../..', '/', '\\', '...']) {
      const path = zipEntryPath(target({ guildName: evil, categoryName: evil, channelName: evil }), 'txt', new Set());
      for (const segment of path.split('/')) {
        expect(segment).not.toBe('');
        expect(segment).not.toBe('.');
        expect(segment).not.toBe('..');
      }
    }
  });

  it('adds the final path to the used set', () => {
    const used = new Set<string>();
    const path = zipEntryPath(target(), 'html', used);
    expect(used.has(path)).toBe(true);
    expect(used.size).toBe(1);
  });

  it('appends the channel id on collisions', () => {
    const used = new Set<string>();
    const a = zipEntryPath(target({ channelId: '1' }), 'html', used);
    const b = zipEntryPath(target({ channelId: '2' }), 'html', used);
    expect(a).toBe('My Server/Text Channels/general.html');
    expect(b).toBe('My Server/Text Channels/general [2].html');
    expect(used).toEqual(new Set([a, b]));
  });

  it('detects collisions case-insensitively', () => {
    const used = new Set<string>();
    zipEntryPath(target({ channelId: '1', channelName: 'General' }), 'html', used);
    const second = zipEntryPath(target({ channelId: '2', channelName: 'general' }), 'html', used);
    expect(second).toBe('My Server/Text Channels/general [2].html');
    const third = zipEntryPath(target({ channelId: '3', guildName: 'MY SERVER', channelName: 'GENERAL' }), 'html', used);
    expect(third).toBe('MY SERVER/Text Channels/GENERAL [3].html');
  });

  it('detects collisions with paths that were added to the set from outside', () => {
    const used = new Set(['My Server/Text Channels/GENERAL.html']);
    expect(zipEntryPath(target({ channelId: '9' }), 'html', used)).toBe('My Server/Text Channels/general [9].html');
  });

  it('stays unique even when the same channel is added repeatedly', () => {
    const used = new Set<string>();
    const paths = [1, 2, 3, 4].map(() => zipEntryPath(target({ channelId: '7' }), 'html', used));
    expect(new Set(paths.map((p) => p.toLowerCase())).size).toBe(4);
    expect(paths[2]).toBe('My Server/Text Channels/general [7] (2).html');
  });

  it('keeps the same name in different categories apart without a suffix', () => {
    const used = new Set<string>();
    const a = zipEntryPath(target({ categoryName: 'A' }), 'html', used);
    const b = zipEntryPath(target({ categoryName: 'B' }), 'html', used);
    expect([a, b]).toEqual(['My Server/A/general.html', 'My Server/B/general.html']);
  });

  it('two posts with one title in a forum are told apart', () => {
    const used = new Set<string>();
    const a = zipEntryPath(target({ kind: 'thread', channelId: '1', channelName: 'help', parentChannelName: 'forum' }), 'html', used, { forumPost: true });
    const b = zipEntryPath(target({ kind: 'thread', channelId: '2', channelName: 'help', parentChannelName: 'forum' }), 'html', used, { forumPost: true });
    expect(a).toBe('My Server/Text Channels/forum/help.html');
    expect(b).toBe('My Server/Text Channels/forum/help [2].html');
  });

  it('keeps every segment within 80 units and the whole path within 180', () => {
    const long = target({ guildName: 'S'.repeat(120), categoryName: 'C'.repeat(120), channelName: 'n'.repeat(120) });
    for (const partial of [false, true]) {
      const path = zipEntryPath(long, 'html', new Set(), { partial, locale: 'ko' });
      expect(path.length).toBeLessThanOrEqual(MAX_PATH_UNITS);
      for (const segment of path.split('/')) expect(segment.length).toBeLessThanOrEqual(MAX_SEGMENT_UNITS);
      expect(path.endsWith(partial ? ' (부분).html' : '.html')).toBe(true);
    }
    const post = target({ kind: 'thread', guildName: 'S'.repeat(120), categoryName: 'C'.repeat(120), channelName: 'n'.repeat(120), parentChannelName: 'P'.repeat(120) });
    const postPath = zipEntryPath(post, 'html', new Set(), { forumPost: true });
    expect(postPath.length).toBeLessThanOrEqual(MAX_PATH_UNITS);
    expect(postPath.split('/')).toHaveLength(4);
  });

  it('cuts long Korean names on character boundaries', () => {
    const long = target({ guildName: '가'.repeat(120), categoryName: '나'.repeat(120), channelName: '😀'.repeat(60) });
    const path = zipEntryPath(long, 'html', new Set());
    expect(hasLoneSurrogate(path)).toBe(false);
    expect(path.length).toBeLessThanOrEqual(MAX_PATH_UNITS);
  });

  it('never yields a reserved device name once the extension is appended', () => {
    const path = zipEntryPath(target({ channelName: 'con', categoryName: null }), 'txt', new Set());
    expect(path).toBe('My Server/_con.txt');
  });
});

describe('zipEntryPath: a path is never both a file and a folder', () => {
  /** No entry may equal, or sit inside, another entry (case-insensitively): extractors cannot make a file and a folder of one name. */
  function expectNoClash(paths: readonly string[]): void {
    const lower = paths.map((p) => p.toLowerCase());
    expect(new Set(lower).size).toBe(lower.length);
    for (const outer of lower) {
      for (const inner of lower) expect(inner.startsWith(`${outer}/`), `${inner} sits inside the file ${outer}`).toBe(false);
    }
  }

  const category = (name: string, channelName: string, channelId: string): ExportTarget => target({ categoryName: name, channelName, channelId });
  const loose = (channelName: string, channelId: string): ExportTarget => target({ categoryName: null, channelName, channelId });

  it('renames the file when a folder of that name already exists (category first)', () => {
    const used = new Set<string>();
    const inFolder = zipEntryPath(category('general.html', 'announcements', '1'), 'html', used);
    const file = zipEntryPath(loose('general', '2'), 'html', used);
    expect(inFolder).toBe('My Server/general.html/announcements.html');
    expect(file).toBe('My Server/general [2].html');
    expectNoClash([inFolder, file]);
  });

  it('renames the folder when a file of that name already exists (channel first)', () => {
    const used = new Set<string>();
    const file = zipEntryPath(loose('general', '2'), 'html', used);
    const inFolder = zipEntryPath(category('general.html', 'announcements', '1'), 'html', used);
    expect(file).toBe('My Server/general.html');
    expect(inFolder).toBe('My Server/general.html (2)/announcements.html');
    expectNoClash([file, inFolder]);
  });

  it('keeps the channels of a renamed category together', () => {
    const used = new Set<string>();
    const file = zipEntryPath(loose('general', '9'), 'html', used);
    const first = zipEntryPath(category('general.html', 'rules', '1'), 'html', used);
    const second = zipEntryPath(category('general.html', 'news', '2'), 'html', used);
    expect([first, second]).toEqual(['My Server/general.html (2)/rules.html', 'My Server/general.html (2)/news.html']);
    expectNoClash([file, first, second]);
  });

  it('compares case-insensitively', () => {
    const used = new Set<string>();
    const file = zipEntryPath(loose('general', '2'), 'html', used);
    const inFolder = zipEntryPath(category('GENERAL.HTML', 'rules', '1'), 'html', used);
    expect(inFolder).toBe('My Server/GENERAL.HTML (2)/rules.html');
    expectNoClash([file, inFolder]);

    const usedBackwards = new Set<string>();
    const folderFirst = zipEntryPath(category('GENERAL.HTML', 'rules', '1'), 'html', usedBackwards);
    const fileSecond = zipEntryPath(loose('general', '2'), 'html', usedBackwards);
    expect(fileSecond).toBe('My Server/general [2].html');
    expectNoClash([folderFirst, fileSecond]);
  });

  it('skips a renamed folder name that is taken as well', () => {
    const used = new Set(['My Server/general.html', 'My Server/general.html (2)']);
    expect(zipEntryPath(category('general.html', 'rules', '1'), 'html', used)).toBe('My Server/general.html (3)/rules.html');
  });

  it('knows paths that were added to the set from outside', () => {
    expect(zipEntryPath(category('general.html', 'rules', '1'), 'html', new Set(['My Server/general.html']))).toBe('My Server/general.html (2)/rules.html');
    expect(zipEntryPath(loose('general', '5'), 'html', new Set(['My Server/general.html/rules.html']))).toBe('My Server/general [5].html');
  });

  it('does not touch folders and files that merely share a prefix', () => {
    const used = new Set<string>();
    const paths = [loose('general', '1'), category('general.html.bak', 'rules', '2'), category('general', 'news', '3')].map((t) => zipEntryPath(t, 'html', used));
    expect(paths).toEqual(['My Server/general.html', 'My Server/general.html.bak/rules.html', 'My Server/general/news.html']);
  });

  it('holds for every order of arrival of a hostile set of names', () => {
    const targets = [loose('x', '1'), loose('X', '2'), category('x.html', 'a', '3'), category('X.HTML', 'b', '4'), category('x.html', 'x', '5'), category('y', 'x', '6')];
    const permutations = (items: ExportTarget[]): ExportTarget[][] =>
      items.length <= 1 ? [items] : items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
    const orders = permutations(targets);
    expect(orders).toHaveLength(720);
    for (const order of orders) {
      const used = new Set<string>();
      expectNoClash(order.map((t) => zipEntryPath(t, 'html', used)));
    }
  });
});

describe('uniqueZipPath', () => {
  it('returns the path unchanged when it is free, and remembers it', () => {
    const used = new Set<string>();
    expect(uniqueZipPath('a/b.txt', used)).toBe('a/b.txt');
    expect(used).toEqual(new Set(['a/b.txt']));
  });

  it('puts " (2)", " (3)" ... before the extension when it is taken (case-insensitively)', () => {
    const used = new Set<string>();
    expect(uniqueZipPath('a/b.txt', used)).toBe('a/b.txt');
    expect(uniqueZipPath('a/b.txt', used)).toBe('a/b (2).txt');
    expect(uniqueZipPath('A/B.TXT', used)).toBe('A/B (3).TXT');
    expect(uniqueZipPath('a/b.txt', used)).toBe('a/b (4).txt');
    expect(used.size).toBe(4);
  });

  it('handles names without an extension and without a folder', () => {
    const used = new Set<string>();
    expect(uniqueZipPath('readme', used)).toBe('readme');
    expect(uniqueZipPath('readme', used)).toBe('readme (2)');
    expect(uniqueZipPath('.hidden', used)).toBe('.hidden');
    expect(uniqueZipPath('.hidden', used)).toBe('.hidden (2)');
  });

  it('never makes a file out of a folder or the other way round', () => {
    const used = new Set(['a/b.txt']);
    expect(uniqueZipPath('a', used)).toBe('a (2)'); // "a" is the folder of an existing file
    expect(uniqueZipPath('a/b.txt/c.txt', used)).toBe('a/b.txt (2)/c.txt'); // it would sit inside an existing file: the folder is renamed
    expect(uniqueZipPath('a/b.txt/d.txt', used)).toBe('a/b.txt (2)/d.txt'); // and the other files of that folder follow it
  });

  it('terminates for any mix of clashes (every clash is fixed by a rename that changes the path)', () => {
    const used = new Set<string>();
    const paths = ['x', 'x/y', 'x/y/z.txt', 'X/Y/Z.TXT', 'x', 'x/y/z.txt', 'x/y.txt/z.txt', 'x/y.txt', 'a.b/c.d/e.f', 'a.b/c.d', 'a.b'];
    const results = paths.map((p) => uniqueZipPath(p, used));
    expect(new Set(results.map((r) => r.toLowerCase())).size).toBe(paths.length);
    for (const outer of results.map((r) => r.toLowerCase())) {
      for (const inner of results.map((r) => r.toLowerCase())) expect(inner.startsWith(`${outer}/`)).toBe(false);
    }
  });
});

describe('zipAttachmentPath', () => {
  it('puts the copy in "<entry stem>_files" next to the entry', () => {
    const { path, relative } = zipAttachmentPath('My Server/Text Channels/general.html', '123456789012345678', 'photo.png');
    expect(path).toBe('My Server/Text Channels/general_files/123456789012345678_photo.png');
    expect(relative).toBe('general_files/123456789012345678_photo.png');
  });

  it('works for entries at the top level and in the Direct Messages folder', () => {
    expect(zipAttachmentPath('chat.html', '1', 'a.png')).toEqual({ path: 'chat_files/1_a.png', relative: 'chat_files/1_a.png' });
    expect(zipAttachmentPath('Direct Messages/Alice.md', '1', 'a.png').path).toBe('Direct Messages/Alice_files/1_a.png');
  });

  it('follows the entry stem, partial marker and id suffix included', () => {
    expect(zipAttachmentPath('S/C/general (부분).html', '1', 'a.png').relative).toBe('general (부분)_files/1_a.png');
    expect(zipAttachmentPath('S/C/general [5] (2).html', '1', 'a.png').relative).toBe('general [5] (2)_files/1_a.png');
  });

  it('is kept within the length budget, and the relative path is what follows the entry folder', () => {
    const entry = zipEntryPath(target({ guildName: 'S'.repeat(80), categoryName: 'C'.repeat(80), channelName: 'n'.repeat(80) }), 'html', new Set());
    const { path, relative } = zipAttachmentPath(entry, '123456789012345678', `${'x'.repeat(200)}.png`);
    expect(path.endsWith(`/${relative}`)).toBe(true);
    expect(path.length).toBeLessThanOrEqual(MAX_PATH_UNITS + 40); // the shared folders are the entry's; only dir + file give way
    for (const segment of path.split('/')) expect(segment.length).toBeLessThanOrEqual(MAX_SEGMENT_UNITS);
    expect(relative.endsWith('.png')).toBe(true);
  });
});
