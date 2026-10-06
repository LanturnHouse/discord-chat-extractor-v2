import { formatDateTime } from '../message/time';
import type { ExportLocale, ExportTarget } from './types';

/**
 * File and path names of an export (docs/PLAN.md §6.6). Everything that ends up in a name is attacker-controlled (channel,
 * server and thread names, attachment file names), so every piece goes through `sanitizeFileName` first.
 *
 *   individual file   <folder>/<server> - <channel>[ (YYYY-MM-DD)][ (partial)].<ext>      DMs: <folder>/DM - <name>…
 *                     threads: <server> - <parent> - <thread>
 *   attachment        <folder>/<file stem>_files/<attachmentId>_<original name>
 *   ZIP               <folder>/Discord Export YYYY-MM-DD HHmm[ (partial)].zip
 *   ZIP entry         <server>/<category>/<channel>.<ext>, Direct Messages/<name>.<ext>, threads <server>/<category>/<parent> - <thread>.<ext>,
 *                     forum posts <server>/<category>/<forum>/<post>.<ext>; attachments <entry stem>_files/<attachmentId>_<original name>
 */

/** Longest single path segment we emit, in UTF-16 code units. */
export const MAX_SEGMENT_UNITS = 80;
/** Longest whole path we emit, in UTF-16 code units (leaves room for the download directory below Windows' 260). */
export const MAX_PATH_UNITS = 180;
/** What the folder name falls back to when nothing usable is left of it. */
export const DEFAULT_FOLDER_NAME = 'Discord Export';

/** The folder prefix (the user's "folder name" setting) may take at most this much of a path, so the rest keeps a sensible budget. */
const MAX_PREFIX_UNITS = 70;
/** ...and at most this many levels (the deeper ones of a setting like "a/b/c/d/e/f" are dropped). */
const MAX_FOLDER_LEVELS = 4;
/** A segment is never trimmed below this when a path is shortened (the id and the extension of an attachment fit in it). */
const MIN_TRIMMED_UNITS = 12;

const DM_FOLDER = 'Direct Messages';

// Zero-width and bidi-control characters are invisible, so the pattern is built from code points instead of being written
// into the source: ZWSP, word joiner, BOM, Arabic letter mark, LRM, RLM, LRE..RLO (U+202A-202E), isolates (U+2066-2069).
const codes = (...points: number[]): string => String.fromCharCode(...points);
/** Zero-width / bidi-control characters: invisible, and RLO-style ones could make the appended extension read backwards. */
const INVISIBLE = new RegExp(`[${codes(0x200b, 0x2060, 0xfeff, 0x061c, 0x200e, 0x200f)}${codes(0x202a)}-${codes(0x202e)}${codes(0x2066)}-${codes(0x2069)}]`, 'g');
/** Windows-forbidden characters, `%` (it starts an escape in a URL / download path), plus C0/C1 control characters and DEL. */
const FORBIDDEN = /[\\/:*?"<>|%\u0000-\u001F\u007F-\u009F]/g;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
/** Windows device names; the superscript digits are reserved too on current Windows. */
const RESERVED_DEVICE = /^(?:CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³])$/i;

function trimDotsAndSpaces(s: string): string {
  return s.replace(/^[. ]+|[. ]+$/g, '');
}

/** Cuts to `max` UTF-16 code units without leaving half of a surrogate pair behind. */
function capUnits(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max;
  const last = s.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return s.slice(0, end);
}

/**
 * `checkReserved` is off for a piece that is put behind a prefix anyway (an attachment's original name behind its id), where
 * a device name cannot be what Windows sees.
 */
function cleanComponent(name: string, max = MAX_SEGMENT_UNITS, checkReserved = true): string {
  let s = name.normalize('NFC');
  // Whitespace is collapsed before FORBIDDEN runs so that tabs/newlines become spaces instead of underscores.
  s = s.replace(INVISIBLE, '').replace(/\s+/g, ' ').replace(FORBIDDEN, '_').replace(LONE_SURROGATE, '_');
  s = trimDotsAndSpaces(s);
  if (s === '') return '';

  // Windows treats "CON", "con.txt" and "CON.anything" alike, so the check looks at the part before the first dot.
  const dot = s.indexOf('.');
  const base = dot === -1 ? s : s.slice(0, dot);
  if (checkReserved && RESERVED_DEVICE.test(base.trimEnd())) s = `_${s}`;

  return trimDotsAndSpaces(capUnits(s, max));
}

/**
 * Turns arbitrary (attacker-controlled) text into one safe path segment (docs/PLAN.md §6.6): no separators, no
 * Windows-forbidden characters (`< > : " / \ | ? *`), control characters, bidi / zero-width characters or `%` (the forbidden ones
 * become `_`, the invisible ones disappear), no reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`-`COM9`, `LPT1`-`LPT9`,
 * also with an extension: they get a `_` in front), no leading / trailing dots or spaces, at most 80 UTF-16 code units.
 */
export function sanitizeFileName(name: string, fallback = 'unnamed'): string {
  return cleanComponent(name) || cleanComponent(fallback) || 'unnamed';
}

/**
 * One piece of a longer name (the channel in "<server> - <channel>"): sanitised like a segment, but without the device-name
 * check, which only matters for what Windows sees as the whole name; the composed name gets that check.
 */
function sanitizePart(name: string, fallback = 'unnamed'): string {
  return cleanComponent(name, MAX_SEGMENT_UNITS, false) || cleanComponent(fallback, MAX_SEGMENT_UNITS, false) || 'unnamed';
}

function normalizeExt(ext: string): string {
  return ext.replace(/^\.+/, '');
}

function isDirectMessage(target: ExportTarget): boolean {
  return target.kind === 'dm' || target.kind === 'group-dm';
}

// ---------------------------------------------------------------------------------------------------------------------
// fitting paths into the length budget
// ---------------------------------------------------------------------------------------------------------------------

const pathUnits = (segments: readonly string[]): number => segments.reduce((sum, s) => sum + s.length, 0) + Math.max(0, segments.length - 1);

/** Splits "name.ext" at the last dot of a file name; an extension longer than 12 units is not one. */
function splitExtension(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || name.length - dot > 13) return { stem: name, ext: '' };
  return { stem: name.slice(0, dot), ext: name.slice(dot) };
}

/**
 * `segment` cut by `by` units from the end of its head; its last `tail` units are protected (the extension of a file, an id
 * suffix that tells two files apart). The head is never cut below `MIN_TRIMMED_UNITS` in all, nor below one unit.
 */
function shorten(segment: string, by: number, tail: number): string {
  const protectedUnits = Math.min(tail, segment.length - 1);
  const head = segment.slice(0, segment.length - protectedUnits);
  const keep = segment.slice(segment.length - protectedUnits);
  const target = Math.max(MIN_TRIMMED_UNITS - keep.length, head.length - by, 1);
  if (target >= head.length) return segment;
  return `${trimDotsAndSpaces(capUnits(head, target)) || head.slice(0, 1)}${keep}`;
}

/**
 * `segments` shortened until the path is at most `maxUnits` long. The longest segments give way first, evenly; the last one is
 * a file whose tail stays (`lastTail`: that many units, or `'extension'`), none below 12 units. A path that cannot be brought
 * under the limit that way is returned as short as it gets.
 */
function fitPath(segments: readonly string[], maxUnits: number, lastTail: number | 'extension' = 0): string[] {
  const result = [...segments];
  const last = result.length - 1;
  const tailOf = (index: number): number => {
    if (index !== last) return 0;
    return lastTail === 'extension' ? splitExtension(result[index]).ext.length : lastTail;
  };
  for (let guard = 0; guard < 64; guard += 1) {
    const excess = pathUnits(result) - maxUnits;
    if (excess <= 0) break;
    const longest = Math.max(...result.map((segment) => segment.length));
    const tied = result.flatMap((segment, index) => (segment.length === longest ? [index] : []));
    const nextLongest = Math.max(MIN_TRIMMED_UNITS, ...result.filter((segment) => segment.length < longest).map((segment) => segment.length));
    const by = Math.min(Math.ceil(excess / tied.length), longest - nextLongest);
    if (by <= 0) break;
    let changed = false;
    for (const index of tied) {
      const next = shorten(result[index], by, tailOf(index));
      changed ||= next !== result[index];
      result[index] = next;
    }
    if (!changed) break;
  }
  return result;
}

/**
 * The folder setting as path segments (`Discord Export`, or `Backups/Discord`): each sanitised, empty ones dropped, at most four
 * levels, the whole kept within 70 units. Nothing usable left => `Discord Export`.
 */
export function folderSegments(folderName: string): string[] {
  const segments = folderName
    .split(/[\\/]+/)
    .map((part) => cleanComponent(part))
    .filter((part) => part !== '')
    .slice(0, MAX_FOLDER_LEVELS);
  return fitPath(segments.length > 0 ? segments : [DEFAULT_FOLDER_NAME], MAX_PREFIX_UNITS);
}

// ---------------------------------------------------------------------------------------------------------------------
// individual files
// ---------------------------------------------------------------------------------------------------------------------

export interface FileNameOptions {
  locale: ExportLocale;
  /** Append ` (YYYY-MM-DD)`, the day of `date` in `timeZone`. */
  dateInFileName: boolean;
  /** The day shown in the name: when the export was made. */
  date: Date;
  /** IANA zone of the date (`'auto'` / unknown => the zone of the machine). */
  timeZone: string;
  /** The file does not hold everything it should: ` (부분)` / ` (partial)` is added. */
  partial: boolean;
}

const PARTIAL_SUFFIX: Record<ExportLocale, string> = { ko: ' (부분)', en: ' (partial)' };
const partialSuffix = (locale: ExportLocale | undefined): string => PARTIAL_SUFFIX[locale === 'ko' ? 'ko' : 'en'];

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Day and clock of `date` in `timeZone` as ['YYYY-MM-DD', 'HHmm']; the machine's own zone for 'auto'. */
function stampOf(date: Date, timeZone: string): readonly [day: string, hhmm: string] {
  if (timeZone !== '' && timeZone !== 'auto') {
    const full = formatDateTime(date.toISOString(), timeZone); // 'YYYY-MM-DD HH:mm:ss'; an unknown zone reads as UTC
    if (full !== '') return [full.slice(0, 10), `${full.slice(11, 13)}${full.slice(14, 16)}`];
  }
  const day = `${String(date.getFullYear()).padStart(4, '0')}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  return [day, `${pad2(date.getHours())}${pad2(date.getMinutes())}`];
}

/** `YYYY-MM-DD` of `date` in `timeZone`; the machine's own zone for 'auto'. */
export function dateStamp(date: Date, timeZone: string): string {
  return stampOf(date, timeZone)[0];
}

function suffixOf(opts: FileNameOptions): string {
  return (opts.dateInFileName ? ` (${dateStamp(opts.date, opts.timeZone)})` : '') + (opts.partial ? partialSuffix(opts.locale) : '');
}

/** The parts of a target's name, each sanitised: `<server> - <channel>`, `DM - <name>`, `<server> - <parent> - <thread>`. */
function nameParts(target: ExportTarget): string[] {
  const name = sanitizePart(target.channelName, target.channelId);
  if (isDirectMessage(target)) return ['DM', name];
  const server = sanitizePart(target.guildName ?? '', 'Unknown Server');
  if (target.kind === 'thread' && target.parentChannelName) return [server, sanitizePart(target.parentChannelName, target.channelId), name];
  return [server, name];
}

/**
 * The file stem of a chat's export file (no extension): its name parts joined with " - ", then the date and the partial marker.
 * The name part is cut when needed so that `<stem>.<ext>` stays within 80 units; the date and the marker are never cut.
 */
export function itemStem(target: ExportTarget, ext: string, opts: FileNameOptions): string {
  const suffix = suffixOf(opts);
  const room = MAX_SEGMENT_UNITS - normalizeExt(ext).length - 1 - suffix.length;
  const core = trimDotsAndSpaces(capUnits(nameParts(target).join(' - '), Math.max(MIN_TRIMMED_UNITS, room)));
  return cleanComponent(`${core}${suffix}`, MAX_SEGMENT_UNITS) || 'unnamed';
}

/** `<stem>.<ext>` */
export function fileNameOf(stem: string, ext: string): string {
  return `${stem}.${normalizeExt(ext)}`;
}

/** Name of the folder next to a file that holds its attachments: `<stem>_files`, within 80 units. */
export function filesFolderName(stem: string): string {
  const suffix = '_files';
  const base = trimDotsAndSpaces(capUnits(stem, MAX_SEGMENT_UNITS - suffix.length));
  return `${base === '' ? 'unnamed' : base}${suffix}`;
}

/** `<attachmentId>_<original name>`, the name sanitised and cut (keeping its extension) to 80 units. */
export function attachmentFileName(attachmentId: string, originalName: string): string {
  const prefix = `${cleanComponent(attachmentId, 24, false) || 'file'}_`;
  const name = cleanComponent(originalName, Number.POSITIVE_INFINITY, false) || 'file';
  const { stem, ext } = splitExtension(name);
  const room = MAX_SEGMENT_UNITS - prefix.length - ext.length;
  const fitted = stem.length <= room ? stem : trimDotsAndSpaces(capUnits(stem, Math.max(1, room))) || 'file';
  return `${prefix}${fitted}${ext}`;
}

/** The individual file: `<folder>/<stem>.<ext>`. */
export function itemFilePath(folderName: string, stem: string, ext: string): string {
  return [...folderSegments(folderName), fileNameOf(stem, ext)].join('/');
}

/** `<dir>/<file>` fitted into what is left of the path budget behind `prefix`: the full path and the part behind the prefix. */
function attachmentPathBehind(prefix: readonly string[], stem: string, attachmentId: string, originalName: string): { path: string; relative: string } {
  const [dir, file] = fitPath([filesFolderName(stem), attachmentFileName(attachmentId, originalName)], MAX_PATH_UNITS - pathUnits(prefix) - 1, 'extension');
  return { path: [...prefix, dir, file].join('/'), relative: `${dir}/${file}` };
}

/**
 * The saved copy of an attachment next to an individual file, and the path of it relative to that file:
 * `<folder>/<stem>_files/<id>_<name>` and `<stem>_files/<id>_<name>`. The two are kept within the length budget together, and the
 * relative one is exactly what follows the file's own folder in the full one, so a link written from it resolves.
 */
export function itemAttachmentPath(folderName: string, stem: string, attachmentId: string, originalName: string): { path: string; relative: string } {
  return attachmentPathBehind(folderSegments(folderName), stem, attachmentId, originalName);
}

// ---------------------------------------------------------------------------------------------------------------------
// ZIP
// ---------------------------------------------------------------------------------------------------------------------

export interface ZipNameOptions {
  /** Zone of the stamp; default / 'auto': the zone of the machine. */
  timeZone?: string;
  /** Appends the partial marker (the ZIP holds only the chats that were finished). */
  partial?: boolean;
  locale?: ExportLocale;
}

/** "Discord Export 2026-10-06 1437.zip" (minutes resolution, in `opts.timeZone`), with ` (부분)` / ` (partial)` for a partial one. */
export function zipFileName(date: Date, opts: ZipNameOptions = {}): string {
  const [day, hhmm] = stampOf(date, opts.timeZone ?? 'auto');
  return `Discord Export ${day} ${hhmm}${opts.partial === true ? partialSuffix(opts.locale) : ''}.zip`;
}

/** The ZIP file itself: `<folder>/Discord Export YYYY-MM-DD HHmm.zip`. */
export function zipFilePath(folderName: string, date: Date, opts: ZipNameOptions = {}): string {
  return [...folderSegments(folderName), zipFileName(date, opts)].join('/');
}

/**
 * Case-insensitive view of the entry paths handed out so far (ZIP paths that differ only by case collide when
 * extracted on Windows/macOS). Besides the files it knows every folder they sit in, because an extractor cannot
 * create a file and a folder of the same name.
 */
export class ZipPathIndex {
  private readonly files = new Set<string>();
  /** Lower-cased folder path -> how many files sit (anywhere) below it. */
  private readonly folders = new Map<string, number>();

  constructor(paths: Iterable<string> = []) {
    for (const path of paths) this.add(path);
  }

  get size(): number {
    return this.files.size;
  }

  add(path: string): void {
    const lower = path.toLowerCase();
    if (this.files.has(lower)) return;
    this.files.add(lower);
    for (let slash = lower.indexOf('/'); slash !== -1; slash = lower.indexOf('/', slash + 1)) {
      const folder = lower.slice(0, slash);
      this.folders.set(folder, (this.folders.get(folder) ?? 0) + 1);
    }
  }

  /** Forgets a path that was added (an entry that failed): its folders are forgotten when nothing else is in them. */
  remove(path: string): void {
    const lower = path.toLowerCase();
    if (!this.files.delete(lower)) return;
    for (let slash = lower.indexOf('/'); slash !== -1; slash = lower.indexOf('/', slash + 1)) {
      const folder = lower.slice(0, slash);
      const left = (this.folders.get(folder) ?? 1) - 1;
      if (left <= 0) this.folders.delete(folder);
      else this.folders.set(folder, left);
    }
  }

  /** `path` as a file would be the same path as another file or as a folder that already holds files. */
  fileClashes(path: string): boolean {
    const lower = path.toLowerCase();
    return this.files.has(lower) || this.folders.has(lower) || this.insideFile(lower);
  }

  /** `path` as a folder would be the same path as a file, or would sit inside one. */
  folderClashes(path: string): boolean {
    return this.insideFile(path.toLowerCase());
  }

  /**
   * `folders` with every name that would be a file's name, or sit inside a file, given " (2)", " (3)" ... until it is free
   * (every file of such a folder gets the same new name, which keeps them together).
   */
  freeFolders(folders: readonly string[]): string[] {
    const result = [...folders];
    for (let level = 0; level < result.length; level += 1) {
      const parents = result.slice(0, level).join('/');
      const name = result[level];
      let candidate = name;
      for (let n = 2; this.folderClashes(parents === '' ? candidate : `${parents}/${candidate}`); n += 1) candidate = `${name} (${n})`;
      result[level] = candidate;
    }
    return result;
  }

  /**
   * `path` as a ZIP entry that clashes with nothing in the index, which it is added to: a folder of it that equals
   * (case-insensitively) a file, or sits inside one, gets " (2)", " (3)" ...; the file gets the same counter in front of its
   * extension when it equals another file or a folder that holds files.
   */
  claim(path: string): string {
    const segments = path.split('/');
    const leaf = segments.pop() ?? path;
    const folders = this.freeFolders(segments);
    const head = folders.length === 0 ? '' : `${folders.join('/')}/`;
    const { stem, ext } = splitExtension(leaf);
    let result = `${head}${leaf}`;
    for (let n = 2; this.fileClashes(result); n += 1) result = `${head}${stem} (${n})${ext}`;
    this.add(result);
    return result;
  }

  /** `lower` is a file, or one of its parent folders is. */
  private insideFile(lower: string): boolean {
    if (this.files.has(lower)) return true;
    for (let slash = lower.indexOf('/'); slash !== -1; slash = lower.indexOf('/', slash + 1)) {
      if (this.files.has(lower.slice(0, slash))) return true;
    }
    return false;
  }
}

/**
 * `path` as a ZIP entry that clashes with nothing in `used` (see `ZipPathIndex.claim`); the result is added to `used`.
 * (`zipEntryPath` makes the nicer, id-based names; this is the safety net the ZIP assembler applies to every entry.)
 */
export function uniqueZipPath(path: string, used: Set<string>): string {
  const result = new ZipPathIndex(used).claim(path);
  used.add(result);
  return result;
}

export interface ZipEntryOptions {
  /** A forum / media post: it goes into a folder named after its forum instead of "<forum> - <post>" next to the channels. */
  forumPost?: boolean;
  /** Adds the partial marker to the name. */
  partial?: boolean;
  locale?: ExportLocale;
}

/**
 * Entry path inside the export ZIP: "Server/Category/channel.ext", "Server/channel.ext" (no category),
 * "Direct Messages/name.ext", "Server/Category/Parent - Thread.ext", or for a forum post "Server/Category/Forum/Post.ext".
 * On a (case-insensitive) collision the channel id is appended: "channel [123].ext". The final path is added to `used`.
 *
 * A file and a folder may not share a path either. Category names are free text, so a category "general.html" next to
 * an uncategorised channel "general" would otherwise yield the file "Srv/general.html" and the folder "Srv/general.html/",
 * which no extractor can unpack. The file gets the id suffix; when the folder is the newcomer it gets " (2)" and so on
 * (the same for every channel of that category, which keeps them together).
 *
 * Every segment is within 80 units and the whole path within 180: the longest names give way, but a file keeps its extension,
 * its partial marker and its id suffix.
 */
export function zipEntryPath(target: ExportTarget, ext: string, used: Set<string>, opts: ZipEntryOptions = {}): string {
  const index = new ZipPathIndex(used);
  const folders: string[] = [];
  if (isDirectMessage(target)) {
    folders.push(DM_FOLDER);
  } else {
    folders.push(sanitizeFileName(target.guildName ?? '', 'Unknown Server'));
    if (target.categoryName) folders.push(sanitizeFileName(target.categoryName, 'Category'));
    if (opts.forumPost === true && target.parentChannelName) folders.push(sanitizeFileName(target.parentChannelName, target.channelId));
  }
  const freed = index.freeFolders(folders);

  const partial = opts.partial === true ? partialSuffix(opts.locale) : '';
  const extension = `.${normalizeExt(ext)}`;
  const base =
    target.kind === 'thread' && target.parentChannelName && opts.forumPost !== true
      ? `${sanitizePart(target.parentChannelName, target.channelId)} - ${sanitizePart(target.channelName, target.channelId)}`
      : sanitizePart(target.channelName, target.channelId);

  /** The path with `suffix` (` [id]`, ` [id] (2)` ...) behind the name; the suffix survives any cutting, so every suffix gives a different path. */
  const pathOf = (suffix: string): string => {
    const tail = `${suffix}${partial}${extension}`;
    const head = trimDotsAndSpaces(capUnits(base, Math.max(MIN_TRIMMED_UNITS, MAX_SEGMENT_UNITS - tail.length)));
    const file = `${cleanComponent(`${head}${suffix}${partial}`, MAX_SEGMENT_UNITS) || 'unnamed'}${extension}`;
    return fitPath([...freed, file], MAX_PATH_UNITS, tail.length).join('/');
  };

  let path = pathOf('');
  if (index.fileClashes(path)) {
    const withId = ` [${target.channelId}]`;
    path = pathOf(withId);
    // Only reachable when the same channel is exported twice; the counter keeps the path unique regardless.
    for (let n = 2; index.fileClashes(path); n += 1) path = pathOf(`${withId} (${n})`);
  }
  used.add(path);
  return path;
}

/**
 * A saved attachment inside the ZIP, next to the entry of the file that shows it: `<entry stem>_files/<id>_<name>`, together
 * with the path relative to that entry (what the file's links use). The shared folders are the entry's own; only the attachment's
 * folder and file name give way when the path is too long.
 */
export function zipAttachmentPath(entryPath: string, attachmentId: string, originalName: string): { path: string; relative: string } {
  const segments = entryPath.split('/');
  const entryName = segments.pop() ?? entryPath;
  return attachmentPathBehind(segments, splitExtension(entryName).stem, attachmentId, originalName);
}
