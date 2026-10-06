/**
 * URL safety helpers shared by every renderer. All URLs that end up in `href` / `src` go through here.
 * Only http(s) (and optionally mailto) are allowed — `javascript:`, `data:`, `file:`, `blob:` … are rejected.
 */
export function safeUrl(input: string | null | undefined, opts: { allowMailto?: boolean } = {}): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed || /[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.href;
  if (opts.allowMailto && parsed.protocol === 'mailto:') return parsed.href;
  return null;
}

const DISCORD_MEDIA_HOST = /(^|\.)(discordapp\.com|discordapp\.net|discord\.com|discordcdn\.com)$/i;

/** True for hosts Discord itself serves media from (the only hosts we load images/video from automatically). */
export function isDiscordMediaUrl(url: string): boolean {
  try {
    return DISCORD_MEDIA_HOST.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

const DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp|svg\+xml)[;,]/i;

/**
 * Safe URL to load automatically as media (`<img src>` / `<video src>` only — never `href`):
 * an http(s) URL on a Discord host, or an inline raster/SVG `data:image/...` (used by the demo client; an SVG inside
 * `<img>` cannot run scripts).
 */
export function safeMediaUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (DATA_IMAGE.test(trimmed)) return trimmed;
  const safe = safeUrl(trimmed);
  return safe && isDiscordMediaUrl(safe) ? safe : null;
}
