// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { frameScheduler } from '@/content/inject/injector';

afterEach(() => {
  vi.useRealTimers();
});

/** A window whose animation frames the test fires by hand (or never). */
function fakeWindow() {
  const callbacks = new Map<number, () => void>();
  let next = 1;
  const win = {
    requestAnimationFrame: (cb: () => void): number => {
      const id = next++;
      callbacks.set(id, cb);
      return id;
    },
    cancelAnimationFrame: (id: number): void => {
      callbacks.delete(id);
    },
  } as unknown as Window;
  return { win, fire: () => Array.from(callbacks.values()).forEach((cb) => cb()), pending: () => callbacks.size };
}

describe('frameScheduler', () => {
  it('runs on the next animation frame, once', () => {
    vi.useFakeTimers();
    const { win, fire } = fakeWindow();
    const run = vi.fn();
    frameScheduler(win)(run);
    expect(run).not.toHaveBeenCalled();
    fire();
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000); // the timer safety net must not run it a second time
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('runs from the timer when frames never come (hidden tab), once', () => {
    vi.useFakeTimers();
    const { win, fire, pending } = fakeWindow();
    const run = vi.fn();
    frameScheduler(win)(run);
    vi.advanceTimersByTime(249);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(pending()).toBe(0); // the frame request was cancelled
    fire();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('can be cancelled', () => {
    vi.useFakeTimers();
    const { win, fire, pending } = fakeWindow();
    const run = vi.fn();
    const cancel = frameScheduler(win)(run);
    cancel();
    expect(pending()).toBe(0);
    fire();
    vi.advanceTimersByTime(1000);
    expect(run).not.toHaveBeenCalled();
  });
});
