/** Inline images, videos and embed pictures are shown inside this box (Discord's limit for chat media). */
export const MEDIA_MAX_WIDTH = 400;
export const MEDIA_MAX_HEIGHT = 300;

export interface Size {
  width: number;
  height: number;
}

/** Dimensions come from the API and are attacker-controlled: only finite positive numbers count. */
function dimension(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Display size that keeps the aspect ratio and fits the box; never upscales. null when either dimension is unknown,
 * in which case CSS (max-width / max-height) bounds the natural size instead.
 */
export function fitBox(width: unknown, height: unknown, maxWidth = MEDIA_MAX_WIDTH, maxHeight = MEDIA_MAX_HEIGHT): Size | null {
  const w = dimension(width);
  const h = dimension(height);
  if (w === null || h === null) return null;
  const scale = Math.min(1, maxWidth / w, maxHeight / h);
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}
