import { useEffect, useState, type ReactElement } from 'react';
import { discordCdnUrl } from '@/ui/format/summary';

export interface ServerIconProps {
  /** The icon URL the background recorded. Only `https://cdn.discordapp.com/...` is ever loaded. */
  url: string | null | undefined;
  /** Where the first letter of the fallback comes from. */
  name: string;
  size?: number;
}

/**
 * The picture in front of a server: its icon (lazy, without a referrer), or - when there is none, the address is not on the
 * Discord CDN, or the image cannot be loaded - a round badge with the first letter of the name.
 */
export function ServerIcon({ url, name, size = 20 }: ServerIconProps): ReactElement {
  const safe = discordCdnUrl(url);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [safe]);
  const style = { width: size, height: size, fontSize: Math.round(size * 0.5) };
  if (safe === null || failed) {
    return (
      <span className="dce-server-icon dce-server-icon--fallback" style={style} aria-hidden="true">
        {Array.from(name.trim())[0]?.toUpperCase() ?? '?'}
      </span>
    );
  }
  return (
    <img
      className="dce-server-icon"
      src={safe}
      alt=""
      width={size}
      height={size}
      style={style}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}
