import type { Embed, EmbedMedia } from '../discord/types';
import { safeMediaUrl, safeUrl } from '../markdown/url';
import { nonEmpty, positiveNumber, str } from './text';

export interface EmbedMediaView {
  /** Always a URL that passed `safeMediaUrl` (Discord host or inline raster data URI). */
  url: string;
  width: number | null;
  height: number | null;
}

export interface NormalizedEmbed {
  /** Discord's embed type: rich | image | video | gifv | article | link | poll_result ...; 'rich' when absent. */
  type: string;
  title: string | null;
  /** `embed.url` passed through `safeUrl`: only http(s) links, safe for `href`. */
  titleUrl: string | null;
  description: string | null;
  author: { name: string; url: string | null; iconUrl: string | null } | null;
  /** Provider name (e.g. "YouTube"); its URL is deliberately not exposed. */
  provider: string | null;
  fields: { name: string; value: string; inline: boolean }[];
  footer: { text: string; iconUrl: string | null } | null;
  /** ISO timestamp as sent, only when it parses. */
  timestamp: string | null;
  /** '#rrggbb' or null. */
  colorHex: string | null;
  image: EmbedMediaView | null;
  thumbnail: EmbedMediaView | null;
  /**
   * Playable video, only when its URL is on a Discord host (`video`/`gifv` embeds from third parties usually are
   * not, e.g. YouTube players). `posterUrl` is the safe thumbnail/image to show before play. When `video` is null the
   * renderer should fall back to `thumbnail`/`image` plus a link.
   */
  video: { url: string; posterUrl: string | null } | null;
}

/**
 * Privacy rule: media is only ever loaded from Discord's own hosts. `proxy_url` is preferred because Discord has
 * already fetched the third-party image for us; a bare third-party `url` fails `safeMediaUrl` and becomes null.
 */
function mediaUrl(media: { proxy_url?: unknown; url?: unknown } | null | undefined): string | null {
  if (!media || typeof media !== 'object') return null;
  return safeMediaUrl(str(media.proxy_url) ?? str(media.url));
}

function mediaView(media: EmbedMedia | null | undefined): EmbedMediaView | null {
  const url = mediaUrl(media);
  if (url === null) return null;
  return { url, width: positiveNumber(media?.width), height: positiveNumber(media?.height) };
}

function colorToHex(color: unknown): string | null {
  if (typeof color !== 'number' || !Number.isInteger(color) || color < 0 || color > 0xffffff) return null;
  return `#${color.toString(16).padStart(6, '0')}`;
}

function isoOrNull(value: unknown): string | null {
  const s = nonEmpty(value);
  return s !== null && !Number.isNaN(Date.parse(s)) ? s : null;
}

export function normalizeEmbed(embed: Embed): NormalizedEmbed {
  const e: Partial<Embed> = embed && typeof embed === 'object' ? embed : {};

  const authorName = nonEmpty(e.author?.name);
  const footerText = nonEmpty(e.footer?.text);
  const image = mediaView(e.image);
  const thumbnail = mediaView(e.thumbnail);
  const videoUrl = mediaUrl(e.video);

  const fields: NormalizedEmbed['fields'] = [];
  if (Array.isArray(e.fields)) {
    for (const f of e.fields) {
      const name = str(f?.name);
      const value = str(f?.value);
      if (name === undefined || value === undefined) continue;
      if (name.trim() === '' && value.trim() === '') continue;
      fields.push({ name, value, inline: f.inline === true });
    }
  }

  return {
    type: nonEmpty(e.type) ?? 'rich',
    title: nonEmpty(e.title),
    titleUrl: safeUrl(str(e.url)),
    description: nonEmpty(e.description),
    author:
      authorName === null
        ? null
        : {
            name: authorName,
            url: safeUrl(str(e.author?.url)),
            iconUrl: mediaUrl({ proxy_url: e.author?.proxy_icon_url, url: e.author?.icon_url }),
          },
    provider: nonEmpty(e.provider?.name),
    fields,
    footer:
      footerText === null
        ? null
        : { text: footerText, iconUrl: mediaUrl({ proxy_url: e.footer?.proxy_icon_url, url: e.footer?.icon_url }) },
    timestamp: isoOrNull(e.timestamp),
    colorHex: colorToHex(e.color),
    image,
    thumbnail,
    video: videoUrl === null ? null : { url: videoUrl, posterUrl: thumbnail?.url ?? image?.url ?? null },
  };
}
