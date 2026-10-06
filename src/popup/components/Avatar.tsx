import { useEffect, useState, type ReactElement } from 'react';
import { safeImageUrl } from '@/ui/format/summary';

export interface AvatarProps {
  url: string | null | undefined;
  /** Where the first letter of the fallback comes from. */
  name: string;
  size?: number;
}

/** A round picture; a missing, foreign or broken image becomes a coloured circle with the first letter of the name. */
export function Avatar({ url, name, size = 32 }: AvatarProps): ReactElement {
  const safe = safeImageUrl(url);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [safe]);
  const style = { width: size, height: size, fontSize: Math.round(size * 0.45) };
  if (safe === null || failed) {
    return (
      <span className="dce-avatar dce-avatar--fallback" style={style} aria-hidden="true">
        {Array.from(name.trim())[0]?.toUpperCase() ?? '?'}
      </span>
    );
  }
  return <img className="dce-avatar" src={safe} alt="" width={size} height={size} style={style} referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}
