import type { Attachment } from '../discord/types';
import { safeMediaUrl } from '../markdown/url';
import type { MessageLocale } from './strings';
import { str } from './text';

export type AttachmentKind = 'image' | 'video' | 'audio' | 'file';

// Extensions are only a fallback for attachments without a usable content_type.
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'jfif', 'gif', 'webp', 'avif', 'bmp', 'svg', 'apng', 'ico', 'heic']);
const VIDEO_EXT = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'ogv', 'wmv', '3gp']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'ogg', 'oga', 'opus', 'flac', 'm4a', 'aac', 'weba', 'wma']);

/** Bit 3 of `Attachment.flags`: the sender marked it as a spoiler (newer clients no longer prefix the filename). */
const FLAG_IS_SPOILER = 1 << 3;

function extensionOf(filename: string | undefined): string {
  if (!filename) return '';
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase();
}

/**
 * content_type wins; the extension decides only when the type is missing or generic (`application/octet-stream`).
 * SVG is an image here: renderers must still load it only through `attachmentMediaUrl` (Discord hosts only),
 * and an SVG inside `<img>` cannot execute script.
 */
export function classifyAttachment(att: Attachment): AttachmentKind {
  const type = str(att?.content_type)?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  const ext = extensionOf(str(att?.filename));
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  return 'file';
}

export function isSpoilerAttachment(att: Attachment): boolean {
  if (str(att?.filename)?.startsWith('SPOILER_')) return true;
  return typeof att?.flags === 'number' && (att.flags & FLAG_IS_SPOILER) !== 0;
}

/**
 * URL a renderer may load automatically (`<img>`/`<video>`/`<audio>` src): the proxy URL when present, and only
 * when it is on a Discord host. null => show a plain link/filename instead.
 */
export function attachmentMediaUrl(att: Attachment): string | null {
  return safeMediaUrl(str(att?.proxy_url) ?? str(att?.url));
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;
const numberFormats = new Map<string, Intl.NumberFormat>();

function numberFormat(locale: MessageLocale | undefined): Intl.NumberFormat {
  const key = locale === 'ko' ? 'ko-KR' : 'en-US';
  let nf = numberFormats.get(key);
  if (!nf) {
    nf = new Intl.NumberFormat(key, { maximumFractionDigits: 1, useGrouping: false });
    numberFormats.set(key, nf);
  }
  return nf;
}

/** 1024-based, one decimal at most: `512 B`, `1.5 KB`, `12 MB`. Invalid input renders as `0 B`. */
export function formatBytes(n: number, locale?: MessageLocale): string {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return '0 B';
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // 1023.96 KB would print as "1,024 KB"; promote it to the next unit instead.
  if (unit < UNITS.length - 1 && Math.round(value * 10) / 10 >= 1024) {
    value /= 1024;
    unit += 1;
  }
  return `${numberFormat(locale).format(unit === 0 ? Math.floor(value) : value)} ${UNITS[unit]}`;
}
