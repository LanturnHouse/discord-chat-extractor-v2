import { CDN_BASE, MEDIA_BASE } from './constants';
import type { Snowflake } from './types';

/**
 * CDN URL builders. Images are always requested as static `.png` (animated hashes `a_…` give the first frame:
 * lighter for the UI and for exported files). Sizes must be powers of two (16…4096).
 *
 * `hash` may also be an already-resolved `data:` / `https:` URL. That never happens with real API data (hashes are hex);
 * the mock client uses it to ship self-contained avatars/icons that render offline.
 */
function passthrough(hash: string): string | null {
  return hash.startsWith('data:') || hash.startsWith('https://') ? hash : null;
}

/** Default avatar index: new username system uses (id >> 22) % 6, legacy discriminators use discrim % 5. */
export function defaultAvatarUrl(userId: Snowflake, discriminator?: string): string {
  const legacy = discriminator && discriminator !== '0' ? Number(discriminator) % 5 : null;
  const index = legacy !== null && Number.isFinite(legacy) ? legacy : Number((BigInt(userId) >> 22n) % 6n);
  return `${CDN_BASE}/embed/avatars/${index}.png`;
}

export function avatarUrl(user: { id: Snowflake; avatar?: string | null; discriminator?: string }, size = 80): string {
  if (!user.avatar) return defaultAvatarUrl(user.id, user.discriminator);
  return passthrough(user.avatar) ?? `${CDN_BASE}/avatars/${user.id}/${user.avatar}.png?size=${size}`;
}

export function guildIconUrl(guildId: Snowflake, hash: string | null | undefined, size = 96): string | null {
  if (!hash) return null;
  return passthrough(hash) ?? `${CDN_BASE}/icons/${guildId}/${hash}.png?size=${size}`;
}

/** Group DM icon. */
export function channelIconUrl(channelId: Snowflake, hash: string | null | undefined, size = 80): string | null {
  if (!hash) return null;
  return passthrough(hash) ?? `${CDN_BASE}/channel-icons/${channelId}/${hash}.png?size=${size}`;
}

/** Custom emoji. Animated emoji are requested as animated WebP so they keep moving in the UI. */
export function emojiUrl(id: Snowflake, animated: boolean, size = 44): string {
  return `${CDN_BASE}/emojis/${id}.${animated ? 'webp' : 'png'}?size=${size}${animated ? '&animated=true' : ''}`;
}

/** Sticker image; Lottie stickers (format 3) have no static image => null. */
export function stickerUrl(id: Snowflake, formatType: number, size = 160): string | null {
  if (formatType === 3) return null;
  const ext = formatType === 4 ? 'gif' : 'png';
  return `${MEDIA_BASE}/stickers/${id}.${ext}?size=${size}`;
}
