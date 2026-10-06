import { describe, expect, it } from 'vitest';
import { ClassCache, sameClassCache, sanitizeClassCache } from '@/content/inject/classCache';

describe('ClassCache', () => {
  const BUTTON = 'iconItem_c69b6d iconBase_c69b6d';
  const SVG = 'actionIcon_c69b6d';

  it('learns the classes of a native icon once, and tells the owner so it can persist them', () => {
    const changes: unknown[] = [];
    const cache = new ClassCache({}, (data) => changes.push(data));
    expect(cache.learn('channel', BUTTON, SVG)).toBe(true);
    expect(cache.learn('channel', BUTTON, SVG)).toBe(false); // nothing new
    expect(changes).toEqual([{ channelIcon: BUTTON, channelSvg: SVG }]);
    expect(cache.buttonClass('channel')).toBe(BUTTON);
    expect(cache.svgClass('channel')).toBe(SVG);
    expect(cache.buttonClass('dm')).toBeNull();
  });

  it('channel and DM are separate lessons', () => {
    const cache = new ClassCache();
    cache.learn('dm', 'closeButton__972a0 reducedClickTarget__972a0', 'closeIcon__972a0');
    expect(cache.snapshot()).toEqual({ dmButton: 'closeButton__972a0 reducedClickTarget__972a0', dmSvg: 'closeIcon__972a0' });
    expect(cache.buttonClass('channel')).toBeNull();
  });

  it('refuses classes that do not belong to the element they claim to come from', () => {
    const cache = new ClassCache();
    expect(cache.learn('channel', 'somethingElse_abc', 'other_abc')).toBe(false);
    expect(cache.learn('dm', BUTTON, SVG)).toBe(false); // channel classes are not DM classes
    expect(cache.learn('channel', null, null)).toBe(false);
    expect(cache.snapshot()).toEqual({});
  });

  it('can learn the button and the svg separately', () => {
    const cache = new ClassCache();
    expect(cache.learn('channel', BUTTON, null)).toBe(true);
    expect(cache.learn('channel', BUTTON, SVG)).toBe(true);
    expect(cache.snapshot()).toEqual({ channelIcon: BUTTON, channelSvg: SVG });
  });

  it('replace() takes what another tab stored, without calling back', () => {
    const changes: unknown[] = [];
    const cache = new ClassCache({}, (data) => changes.push(data));
    cache.replace({ channelIcon: BUTTON });
    expect(cache.buttonClass('channel')).toBe(BUTTON);
    expect(changes).toEqual([]);
  });

  it('sanitizeClassCache keeps only strings that look like class lists of the right element', () => {
    expect(sanitizeClassCache({ channelIcon: BUTTON, channelSvg: SVG, dmButton: 'closeButton_x', dmSvg: 'closeIcon_x', extra: 'x' })).toEqual({
      channelIcon: BUTTON,
      channelSvg: SVG,
      dmButton: 'closeButton_x',
      dmSvg: 'closeIcon_x',
    });
    expect(sanitizeClassCache({ channelIcon: '<img src=x onerror=alert(1)>', channelSvg: 5, dmButton: 'closeButton_x"; x', dmSvg: 'a'.repeat(400) })).toEqual({});
    expect(sanitizeClassCache({ channelIcon: Array.from({ length: 13 }, (_, i) => `iconItem_${i}`).join(' ') })).toEqual({});
    for (const value of [null, undefined, 'x', 5, []]) expect(sanitizeClassCache(value)).toEqual({});
  });

  it('sameClassCache compares the four fields', () => {
    expect(sameClassCache({ channelIcon: 'a' }, { channelIcon: 'a' })).toBe(true);
    expect(sameClassCache({ channelIcon: 'a' }, { channelIcon: 'b' })).toBe(false);
    expect(sameClassCache({}, { dmSvg: 'x' })).toBe(false);
  });
});
