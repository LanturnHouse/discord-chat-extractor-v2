import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

/** Keeps the newest value in a ref so long-lived listeners never call a stale closure. */
export function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

/**
 * Calls `handler` when Escape is pressed (not while an input method is composing, and not when something nearer already
 * handled the key: a handler that wants to be the only one calls `event.preventDefault()`).
 */
export function useEscapeKey(handler: () => void, enabled = true): void {
  const latest = useLatest(handler);
  useEffect(() => {
    if (!enabled) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      event.preventDefault();
      latest.current();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [enabled, latest]);
}
