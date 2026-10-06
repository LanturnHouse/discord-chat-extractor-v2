/**
 * The class names learned from Discord's own icons (docs/PLAN.md §4, `LOCAL.classCache`): rows that have no native icon of
 * their own (a thread, a voice row without icons, a category, a DM without a close button) reuse what another row taught us, so
 * their button still gets Discord's selected / size / colour rules. Written by the content script, shared by all tabs.
 */
import { STEM } from '../dom/selectors';

/** The `LOCAL.classCache` shape (docs/PLAN.md §5.2). */
export interface ClassCacheData {
  channelIcon?: string;
  channelSvg?: string;
  dmButton?: string;
  dmSvg?: string;
}

export type CacheKind = 'channel' | 'dm';

const FIELD = {
  channel: { button: 'channelIcon', svg: 'channelSvg' },
  dm: { button: 'dmButton', svg: 'dmSvg' },
} as const;

/** What a learned class string must contain: the stem of the element it was read from (garbage is never cached). */
const REQUIRED_STEM = {
  channelIcon: `${STEM.channelIcon}_`,
  channelSvg: `${STEM.channelSvg}_`,
  dmButton: `${STEM.dmClose}_`,
  dmSvg: `${STEM.dmCloseSvg}_`,
} as const;

const CLASS_STRING = /^[A-Za-z0-9_-]+(?: [A-Za-z0-9_-]+){0,11}$/;

function acceptable(field: keyof ClassCacheData, value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 300 || !CLASS_STRING.test(value)) return false;
  return value.split(' ').some((token) => token.startsWith(REQUIRED_STEM[field]));
}

/** Storage value -> a clean cache (unknown keys, non-strings and anything that is not a class list are dropped). */
export function sanitizeClassCache(value: unknown): ClassCacheData {
  const out: ClassCacheData = {};
  if (typeof value !== 'object' || value === null) return out;
  const record = value as Record<string, unknown>;
  for (const field of Object.keys(REQUIRED_STEM) as (keyof ClassCacheData)[]) {
    const v = record[field];
    if (acceptable(field, v)) out[field] = v;
  }
  return out;
}

export function sameClassCache(a: ClassCacheData, b: ClassCacheData): boolean {
  return (
    a.channelIcon === b.channelIcon && a.channelSvg === b.channelSvg && a.dmButton === b.dmButton && a.dmSvg === b.dmSvg
  );
}

export class ClassCache {
  private data: ClassCacheData;

  /** `onChange` is called with the new data whenever a lesson changed something (the owner persists it, debounced). */
  constructor(
    initial: ClassCacheData = {},
    private readonly onChange: (data: ClassCacheData) => void = () => undefined,
  ) {
    this.data = sanitizeClassCache(initial);
  }

  snapshot(): ClassCacheData {
    return { ...this.data };
  }

  /** Replaces the data with what another tab / an earlier visit stored (no change callback). */
  replace(value: unknown): void {
    this.data = sanitizeClassCache(value);
  }

  buttonClass(kind: CacheKind): string | null {
    return this.data[FIELD[kind].button] ?? null;
  }

  svgClass(kind: CacheKind): string | null {
    return this.data[FIELD[kind].svg] ?? null;
  }

  /** Remembers the classes of a native icon. Returns true when that taught us something new. */
  learn(kind: CacheKind, button: string | null, svg: string | null): boolean {
    const fields = FIELD[kind];
    const next: ClassCacheData = { ...this.data };
    if (button && acceptable(fields.button, button)) next[fields.button] = button;
    if (svg && acceptable(fields.svg, svg)) next[fields.svg] = svg;
    if (sameClassCache(next, this.data)) return false;
    this.data = next;
    this.onChange({ ...next });
    return true;
  }
}
