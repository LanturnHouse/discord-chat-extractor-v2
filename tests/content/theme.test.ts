// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { THEME_VARS, ThemeWatcher, captureTheme } from '@/content/theme';
import { LOCAL } from '@/shared/storageKeys';
import type { ThemeTokens } from '@/shared/types';
import { boot, type Booted } from './helpers/app';
import { ID, channelRow, sidebar } from './helpers/fixtures';

const root = document.documentElement;
let ctx: Booted | null = null;

const resetRoot = (): void => {
  for (const name of root.getAttributeNames()) root.removeAttribute(name);
};

beforeEach(() => {
  resetRoot();
  document.body.innerHTML = '';
});

afterEach(() => {
  ctx?.app.destroy();
  ctx = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetRoot();
});

/** The variables of docs/PLAN.md §4 ("테마 변수"), written out here so the list cannot drift unnoticed. */
const PLAN_VARS = [
  '--background-base-low', '--background-base-lower', '--background-base-lowest',
  '--background-surface-high', '--background-surface-higher', '--background-surface-highest',
  '--background-mod-subtle', '--background-mod-normal', '--background-mod-strong', '--background-mod-muted',
  '--border-subtle', '--border-normal', '--border-strong',
  '--brand-500', '--brand-560', '--control-brand-foreground',
  '--text-default', '--text-muted', '--text-strong', '--text-subtle', '--text-link',
  '--icon-default', '--icon-muted', '--icon-strong',
  '--interactive-muted',
  '--input-background-default', '--input-border-default', '--input-border-hover', '--input-border-active',
  '--modal-background', '--modal-footer-background',
  '--radius-xs', '--radius-sm', '--radius-md', '--radius-lg',
  '--status-danger', '--status-positive', '--status-warning',
  '--font-primary', '--channels-default',
  '--interactive-text-default', '--interactive-text-hover', '--interactive-text-active',
  '--interactive-icon-default', '--interactive-icon-hover', '--interactive-icon-active',
  '--interactive-background-hover', '--interactive-background-active', '--interactive-background-selected',
  '--channel-icon',
];

describe('the variable list', () => {
  it('is exactly the one of PLAN §4', () => {
    expect([...THEME_VARS].sort()).toEqual([...PLAN_VARS].sort());
    expect(new Set(THEME_VARS).size).toBe(THEME_VARS.length);
  });

  it('does not contain the variables the plan says are undefined in the current client', () => {
    for (const name of THEME_VARS) {
      expect(name).not.toMatch(/^--(?:interactive-normal|interactive-hover|text-normal|header-primary|background-modifier-)/);
    }
  });
});

describe('captureTheme', () => {
  it('reads the variables from the computed style of <html>, with the theme-* classes, the scheme and the page language', () => {
    root.className = 'theme-dark theme-midnight visual-refresh';
    root.lang = 'ko';
    root.style.setProperty('--text-default', 'color-mix(in oklab, hsl(0 0% 100% / 1) 100%, #000 0%)');
    root.style.setProperty('--background-base-lowest', ' hsl(240 7% 10%) ');
    root.style.setProperty('--radius-md', '8px');
    root.style.setProperty('--not-in-the-list', 'red');
    const tokens = captureTheme(document, 42);
    expect(tokens).toEqual({
      scheme: 'dark',
      themeClasses: ['theme-dark', 'theme-midnight'], // only theme-*, not visual-refresh
      vars: {
        '--text-default': 'color-mix(in oklab, hsl(0 0% 100% / 1) 100%, #000 0%)',
        '--background-base-lowest': 'hsl(240 7% 10%)', // trimmed
        '--radius-md': '8px',
      },
      lang: 'ko',
      capturedAt: 42,
    });
  });

  it('values come through a stylesheet rule on :root as well', () => {
    const style = document.createElement('style');
    style.textContent = ':root { --brand-500: #5865f2; --font-primary: "gg sans", sans-serif; }';
    document.head.appendChild(style);
    expect(captureTheme(document).vars).toMatchObject({ '--brand-500': '#5865f2' });
    style.remove();
  });

  it('light theme: scheme light', () => {
    root.className = 'theme-light';
    expect(captureTheme(document)).toMatchObject({ scheme: 'light', themeClasses: ['theme-light'] });
  });

  it('every other theme, and none at all, is dark', () => {
    for (const name of ['theme-darker', 'theme-onyx', 'theme-midnight', 'theme-dark']) {
      root.className = name;
      expect(captureTheme(document).scheme, name).toBe('dark');
    }
    root.className = '';
    expect(captureTheme(document)).toMatchObject({ scheme: 'dark', themeClasses: [], vars: {}, lang: '' });
  });

  it('leaves out variables Discord does not define', () => {
    root.style.setProperty('--text-default', '#fff');
    expect(Object.keys(captureTheme(document).vars)).toEqual(['--text-default']);
  });

  it('never changes <html>: no class, no attribute is added', () => {
    root.className = 'theme-dark';
    root.lang = 'en';
    const before = root.getAttributeNames().map((name) => [name, root.getAttribute(name)]);
    captureTheme(document);
    expect(root.getAttributeNames().map((name) => [name, root.getAttribute(name)])).toEqual(before);
  });
});

describe('ThemeWatcher', () => {
  const setup = () => {
    const written: ThemeTokens[] = [];
    const captured: ThemeTokens[] = [];
    const watcher = new ThemeWatcher({ doc: document, write: (t) => written.push(t), onCaptured: (t) => captured.push(t) });
    return { watcher, written, captured };
  };

  it('captures once shortly after start (debounced), and writes it', () => {
    vi.useFakeTimers();
    root.className = 'theme-dark';
    const { watcher, written } = setup();
    watcher.start();
    expect(written).toEqual([]);
    vi.advanceTimersByTime(399);
    expect(written).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ scheme: 'dark', themeClasses: ['theme-dark'] });
    watcher.stop();
  });

  it('captures again, debounced, when the class of <html> changes - one write for a burst of changes', async () => {
    vi.useFakeTimers();
    root.className = 'theme-dark';
    const { watcher, written } = setup();
    watcher.start();
    vi.advanceTimersByTime(500);
    expect(written).toHaveLength(1);

    root.className = 'theme-light';
    root.classList.add('theme-custom');
    root.classList.remove('theme-custom');
    await Promise.resolve(); // mutation callbacks
    expect(written).toHaveLength(1);
    vi.advanceTimersByTime(500);
    expect(written).toHaveLength(2);
    expect(written[1]).toMatchObject({ scheme: 'light', themeClasses: ['theme-light'] });
    watcher.stop();
  });

  it('also follows the page language', async () => {
    vi.useFakeTimers();
    root.lang = 'ko';
    const { watcher, written } = setup();
    watcher.start();
    vi.advanceTimersByTime(500);
    root.lang = 'en-US';
    await Promise.resolve();
    vi.advanceTimersByTime(500);
    expect(written.map((t) => t.lang)).toEqual(['ko', 'en-US']);
    watcher.stop();
  });

  it('does not write an unchanged theme again, but still reports every capture', async () => {
    vi.useFakeTimers();
    root.className = 'theme-dark';
    const { watcher, written, captured } = setup();
    watcher.start();
    vi.advanceTimersByTime(500);
    root.className = 'theme-dark theme-dark'; // an attribute mutation that changes nothing we store
    root.className = 'theme-dark';
    await Promise.resolve();
    vi.advanceTimersByTime(500);
    expect(written).toHaveLength(1);
    expect(captured.length).toBeGreaterThanOrEqual(2);
    watcher.stop();
  });

  it('stop() ends it: no more captures', async () => {
    vi.useFakeTimers();
    const { watcher, written } = setup();
    watcher.start();
    watcher.stop();
    vi.advanceTimersByTime(1000);
    root.className = 'theme-light';
    await Promise.resolve();
    vi.advanceTimersByTime(1000);
    expect(written).toEqual([]);
  });

  it('observes only class and lang of <html>, never anything inside the page', async () => {
    vi.useFakeTimers();
    const { watcher, written } = setup();
    watcher.start();
    vi.advanceTimersByTime(500);
    document.body.className = 'something';
    document.body.innerHTML = '<div class="theme-light"></div>';
    root.setAttribute('data-other', 'x');
    await Promise.resolve();
    vi.advanceTimersByTime(1000);
    expect(written).toHaveLength(1);
    watcher.stop();
  });
});

describe('theme in the running content script', () => {
  it('is written to chrome.storage.local (dce.theme) shortly after start, and again after a theme change', async () => {
    vi.useFakeTimers();
    root.className = 'theme-dark theme-midnight';
    root.lang = 'ko';
    root.style.setProperty('--text-default', '#dbdee1');
    ctx = await boot({ html: sidebar(channelRow({ id: ID.general, name: 'general' })) });
    expect(ctx.chrome.storage.get(LOCAL.theme)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(500);
    expect(ctx.chrome.storage.get(LOCAL.theme)).toMatchObject({
      scheme: 'dark',
      themeClasses: ['theme-dark', 'theme-midnight'],
      vars: { '--text-default': '#dbdee1' },
      lang: 'ko',
    });

    root.className = 'theme-light';
    await vi.advanceTimersByTimeAsync(500);
    expect(ctx.chrome.storage.get(LOCAL.theme)).toMatchObject({ scheme: 'light', themeClasses: ['theme-light'] });
  });

  it('keeps being captured while the buttons are switched off (the popup still needs the theme)', async () => {
    vi.useFakeTimers();
    root.className = 'theme-dark';
    ctx = await boot({ html: sidebar(channelRow({ id: ID.general, name: 'general' })), settings: { showButtons: false } });
    await vi.advanceTimersByTimeAsync(500);
    expect(ctx.chrome.storage.get(LOCAL.theme)).toMatchObject({ scheme: 'dark' });
  });

  it('adds nothing to <html> itself', async () => {
    vi.useFakeTimers();
    root.className = 'theme-dark';
    root.lang = 'ko';
    const attributes = () => Object.fromEntries(root.getAttributeNames().map((name) => [name, root.getAttribute(name)]));
    const before = attributes();
    ctx = await boot({ html: sidebar(channelRow({ id: ID.general, name: 'general' })) });
    await vi.advanceTimersByTimeAsync(2000);
    expect(attributes()).toEqual(before);
    expect(before).toEqual({ class: 'theme-dark', lang: 'ko' });
    expect(root.classList.contains('dce')).toBe(false);
  });

  it('stops with the extension context', async () => {
    vi.useFakeTimers();
    ctx = await boot({ html: sidebar(channelRow({ id: ID.general, name: 'general' })) });
    ctx.chrome.invalidate();
    ctx.app.destroy();
    ctx.chrome.storage.delete(LOCAL.theme);
    root.className = 'theme-light';
    await vi.advanceTimersByTimeAsync(2000);
    expect(ctx.chrome.storage.has(LOCAL.theme)).toBe(false);
  });
});
